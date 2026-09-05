import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { loadWorkerConfig } from "@mandate/config";
import type { ExecutionRow, TransactionRow } from "@mandate/database";
import { USDC } from "@mandate/evm";
import type { Context } from "@mandate/execution";
import {
  custom,
  decodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WorkerChain } from "../src/chain.js";

afterEach(() => mock.restore());
const key = `0x${"11".repeat(32)}` as const;
const spender = privateKeyToAccount(key).address;
const recipient = `0x${"22".repeat(20)}` as const;
function chain() {
  return new WorkerChain(
    loadWorkerConfig({
      DATABASE_URL: "postgresql://localhost/test",
      WORKER_EXECUTE: "1",
      WORKER_PRIVATE_KEY: key,
      SPENDER_ADDRESS: spender,
    }),
    custom({
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0x2105";
        throw new Error(`Unexpected test RPC: ${method}`);
      },
    }),
  );
}
// Only fields consumed by the refund boundary are required for these fixtures.
const order = { amountIn: "10000000" } as ExecutionRow;
const context = { draft: { account: recipient } } as Context;
test("refund signs exactly the funded amount to its original account on Base", async () => {
  const c = chain();
  if (!c.wallet) throw new Error("Missing test wallet");
  spyOn(c.client, "getChainId").mockResolvedValue(8453);
  spyOn(c.client, "readContract").mockImplementation((async (request: { functionName: string }) =>
    request.functionName === "balanceOf" ? 999000000n : 0n) as typeof c.client.readContract);
  spyOn(c.client, "getTransactionCount").mockResolvedValue(7);
  spyOn(c.client, "call").mockResolvedValue({ data: "0x" });
  spyOn(c.wallet, "prepareTransactionRequest").mockImplementation((async (request: {
    to?: Hex;
    data?: Hex;
  }) => ({
    ...request,
    chainId: 8453,
    nonce: 7,
    gas: 100000n,
    maxFeePerGas: 100000000n,
    maxPriorityFeePerGas: 1000000n,
    type: "eip1559",
  })) as typeof c.wallet.prepareTransactionRequest);
  const tx = await c.prepare("refund", order, context);
  const decoded = parseTransaction(tx.rawTransaction as Hex);
  expect(decoded.chainId).toBe(8453);
  expect(decoded.to?.toLowerCase()).toBe(USDC.toLowerCase());
  const call = decodeFunctionData({ abi: erc20Abi, data: decoded.data as Hex });
  expect(call.functionName).toBe("transfer");
  expect(call.args).toEqual([recipient, 10000000n]);
  expect(
    await recoverTransactionAddress({
      serializedTransaction: tx.rawTransaction as TransactionSerialized,
    }),
  ).toBe(spender);
  expect(tx.hash).toBe(keccak256(tx.rawTransaction as Hex));
  expect(tx.nonce).toBe(7);
});
test("external pending nonce and insufficient funded balance block signing", async () => {
  for (const insufficient of [true, false]) {
    const c = chain();
    spyOn(c.client, "getChainId").mockResolvedValue(8453);
    spyOn(c.client, "readContract").mockImplementation((async (request: {
      functionName: string;
    }) =>
      request.functionName === "balanceOf"
        ? insufficient
          ? 1n
          : 10000000n
        : 0n) as typeof c.client.readContract);
    spyOn(c.client, "getTransactionCount").mockImplementation(async (request) =>
      request.blockTag === "latest" ? 1 : 2,
    );
    await expect(c.prepare("refund", order, context)).rejects.toThrow(
      insufficient ? "no longer available" : "unknown pending",
    );
  }
});
test("unknown hash with consumed nonce is ambiguous, not successful or safe to retry", async () => {
  const c = chain();
  const hash = `0x${"33".repeat(32)}` as const;
  spyOn(c.client, "getChainId").mockResolvedValue(8453);
  spyOn(c.client, "getTransactionReceipt").mockRejectedValue(
    new TransactionReceiptNotFoundError({ hash }),
  );
  spyOn(c.client, "getTransactionCount").mockResolvedValue(8);
  expect(await c.observe({ hash, signer: spender, nonce: 7 } as TransactionRow)).toBe("ambiguous");
});
test("disabled execution and altered journal bytes cannot reach broadcast", async () => {
  const disabled = new WorkerChain(
    loadWorkerConfig({ DATABASE_URL: "postgresql://localhost/test" }),
  );
  const tx = {
    rawTransaction: "0x1234",
    hash: `0x${"00".repeat(32)}`,
    signer: spender.toLowerCase(),
  } as TransactionRow;
  await expect(disabled.broadcast(tx)).rejects.toThrow("Invalid journal");
  await expect(chain().broadcast(tx)).rejects.toThrow("Invalid journal");
});
