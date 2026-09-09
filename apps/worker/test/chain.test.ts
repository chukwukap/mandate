import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EmbeddedWallet, PrivySigner } from "@mandate/auth";
import { loadWorkerConfig } from "@mandate/config";
import type { DraftRow, ExecutionRow, InstanceRow, TransactionRow } from "@mandate/database";
import { ASSETS, USDC } from "@mandate/evm";
import { type Context, RecoveryRequired } from "@mandate/execution";
import { authorizationMessage, digest, type Envelope, type Plan, review } from "@mandate/strategy";
import {
  custom,
  decodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type TransactionSerialized,
  verifyMessage,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROUTER, WorkerChain } from "../src/chain.js";

afterEach(() => mock.restore());

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture");
  return value;
}

/**
 * The user's embedded wallet, stood in for by a local key.
 *
 * Privy hands the worker a viem account whose `signTransaction` round-trips to Privy; a local
 * account has the same shape and signs the same bytes, so everything downstream of the signer —
 * simulation, serialisation, the journal row — is exercised for real. What is NOT covered here
 * is Privy's own delegation check at signing time, which no local key can imitate.
 */
const key = `0x${"11".repeat(32)}` as const;
const user = privateKeyToAccount(key);
const wallet: EmbeddedWallet = {
  id: "wallet-1",
  address: user.address.toLowerCase() as Hex,
  delegated: true,
};
const asset = required(ASSETS[0]);
const origin = "http://localhost:3000";
const router = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

function signer(delegated = true): PrivySigner {
  return {
    wallet: async () => ({ ...wallet, delegated }),
    account: () => user,
  } as unknown as PrivySigner;
}

/**
 * Only what the wallet client asks for while it fills gas and fees. Everything the public
 * client reads is mocked per test on the client itself, so any other method reaching the
 * transport is a read the test did not expect and should fail loudly.
 */
function transport() {
  return custom({
    request: async ({ method }) => {
      switch (method) {
        case "eth_chainId":
          return "0x2105";
        case "eth_estimateGas":
          return "0x186a0";
        case "eth_maxPriorityFeePerGas":
        case "eth_gasPrice":
          return "0xf4240";
        case "eth_getBlockByNumber":
          return {
            baseFeePerGas: "0x3b9aca00",
            number: "0x1",
            hash: `0x${"44".repeat(32)}`,
            timestamp: "0x1",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            transactions: [],
          };
        default:
          throw new Error(`Unexpected test RPC: ${method}`);
      }
    },
  });
}

function chain(options: { delegated?: boolean; execute?: boolean } = {}) {
  const live = options.execute ?? true;
  return new WorkerChain(
    loadWorkerConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/test",
      WORKER_EXECUTE: live ? "1" : "0",
      ...(live
        ? { PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret", PRIVY_AUTHORIZATION_KEY: "quorum" }
        : {}),
      ELIGIBLE_COUNTRIES: "NG",
      // These tests run whenever CI does; the session window is covered by worker.test.ts.
      WORKER_IGNORE_SESSION: "1",
    }),
    transport(),
    live ? signer(options.delegated) : undefined,
  );
}

/**
 * A strategy the user genuinely signed, so `prepare` passes the same commitment check the
 * worker runs in production rather than a stubbed one. Cheap to build and it keeps this test
 * honest about what stands between an order row and a signature.
 */
async function fixture() {
  const plan: Plan = {
    params: [],
    nodes: [
      {
        id: "cheap",
        op: "lt",
        args: [
          { kind: "feed", feed: `oracle:${asset.symbol}` },
          { kind: "const", value: "300" },
        ],
      },
    ],
    machines: [
      {
        id: "buy",
        scope: "portfolio",
        initial: "watch",
        states: [
          {
            id: "watch",
            transitions: [
              {
                when: "cheap",
                fires: "on_edge",
                to: "watch",
                actions: [
                  { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const envelope: Envelope = {
    version: "mandate/2",
    quote: USDC,
    venue: "aerodrome",
    assets: [asset],
    caps: {
      lifetime: "100",
      per_order: "10",
      per_period: "100",
      period_secs: 86400,
      max_orders_per_period: 10,
      cooldown_secs: 60,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      slippage_bps: 50,
    },
  };
  const rendered = review(plan, envelope);
  const id = randomUUID();
  const userId = randomUUID();
  const name = "Chain fixture";
  const mode = "auto";
  const expiresAt = new Date(Date.now() + 1800000);
  const artifactId = digest({
    id,
    user: userId,
    account: wallet.address,
    name,
    mode,
    plan,
    envelope,
    render: rendered.render_text,
    expires: expiresAt.toISOString(),
  });
  const confirmMessage = authorizationMessage({
    origin,
    chainId: 8453,
    account: wallet.address,
    artifact: artifactId,
    name,
    mode,
    expires: expiresAt.toISOString(),
    render: rendered.render_text,
  });
  const draft = {
    id,
    userId,
    account: wallet.address,
    artifactId,
    name,
    mode,
    plan,
    envelope,
    renderText: rendered.render_text,
    renderHash: rendered.render_sha256,
    confirmMessage,
    reading: "Fixture",
    createdAt: new Date(),
    expiresAt,
    consumedAt: new Date(),
  } as DraftRow;
  const instance = {
    id: randomUUID(),
    userId,
    draftId: id,
    mode: "auto",
    status: "armed",
    signature: await user.signMessage({ message: confirmMessage }),
    eligibleCountry: "NG",
    eligibilityExpiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as InstanceRow;
  const order = {
    id: randomUUID(),
    userId,
    instanceId: instance.id,
    status: "admitted",
    stage: "approve",
    tokenIn: USDC,
    tokenOut: asset.token,
    amountIn: "10000000",
    createdAt: new Date(),
    intent: { asset: 0, side: "buy", amount: "10", fireKey: "buy/watch/0" },
  } as ExecutionRow;
  const context: Context = {
    draft,
    instance,
    owner: { id: userId, privyDid: "did:privy:chain-test" },
  };
  return { context, order };
}

const MIN_OUT = "4975000";

/** A healthy Base: fresh oracle, transfers allowed, the wallet funded, nothing in flight. */
function healthy(c: WorkerChain, options: { cash?: bigint; pending?: number } = {}) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  spyOn(c.client, "getChainId").mockResolvedValue(8453);
  spyOn(c.reader, "verifyMessage").mockImplementation((address, message, signature) =>
    verifyMessage({ address, message, signature }),
  );
  spyOn(c.reader, "market").mockResolvedValue([
    { uri: `oracle:${asset.symbol}`, value: "200", updated_at: Number(now), stale: false },
    { uri: `dex:${asset.symbol}`, value: "200", updated_at: Number(now), stale: false },
  ]);
  spyOn(c.reader, "quote").mockResolvedValue({
    token_in: USDC,
    token_out: asset.token,
    amount_in: "10",
    amount_out: "0.05",
    min_out: MIN_OUT,
    tick_spacing: 100,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    reference: "200",
  });
  spyOn(c.client, "readContract").mockImplementation((async (request: {
    address: Hex;
    functionName: string;
  }) => {
    switch (request.functionName) {
      case "balanceOf":
        return request.address.toLowerCase() === USDC.toLowerCase()
          ? (options.cash ?? 999000000n)
          : 0n;
      case "getOracleParams":
        return [1n, false];
      case "isPaused":
        return false;
      case "latestRoundData":
        return [1n, 20000000000n, now, now, 1n];
      case "TRANSFER_RECEIVER_POLICY":
        return `0x${"01".repeat(32)}`;
      case "policyId":
        return 1n;
      case "isAuthorized":
        return true;
      default:
        throw new Error(`Unexpected contract read: ${request.functionName}`);
    }
  }) as typeof c.client.readContract);
  spyOn(c.client, "getTransactionCount").mockImplementation(async (request) =>
    request.blockTag === "pending" ? (options.pending ?? 7) : 7,
  );
  spyOn(c.client, "call").mockResolvedValue({ data: "0x" });
}

test("approve then swap are signed by the user's wallet, with the user as recipient", async () => {
  // The whole point of the design: no worker key touches the money. Both legs are signed from
  // the strategy wallet, the approval names the router, and the swap delivers to the user.
  const c = chain();
  healthy(c);
  const { context, order } = await fixture();

  const approve = await c.prepare("approve", order, context);
  const approval = parseTransaction(approve.rawTransaction as Hex);
  expect(approval.chainId).toBe(8453);
  expect(approval.to?.toLowerCase()).toBe(USDC.toLowerCase());
  const allowance = decodeFunctionData({ abi: erc20Abi, data: approval.data as Hex });
  expect(allowance.functionName).toBe("approve");
  expect(allowance.args).toEqual([ROUTER, 10000000n]);
  expect(
    await recoverTransactionAddress({
      serializedTransaction: approve.rawTransaction as TransactionSerialized,
    }),
  ).toBe(user.address);
  expect(approve.signer).toBe(wallet.address);
  expect(approve.hash).toBe(keccak256(approve.rawTransaction as Hex));
  expect(approve.nonce).toBe(7);
  expect(approve.evidence).toBeNull();

  const swap = await c.prepare("swap", order, context);
  const trade = parseTransaction(swap.rawTransaction as Hex);
  expect(trade.to?.toLowerCase()).toBe(ROUTER.toLowerCase());
  const call = decodeFunctionData({ abi: router, data: trade.data as Hex });
  expect(call.functionName).toBe("exactInputSingle");
  const [params] = call.args;
  expect(params.tokenIn.toLowerCase()).toBe(USDC.toLowerCase());
  expect(params.tokenOut.toLowerCase()).toBe(asset.token.toLowerCase());
  expect(params.recipient.toLowerCase()).toBe(wallet.address);
  expect(params.amountIn).toBe(10000000n);
  expect(params.amountOutMinimum).toBe(BigInt(MIN_OUT));
  expect(
    await recoverTransactionAddress({
      serializedTransaction: swap.rawTransaction as TransactionSerialized,
    }),
  ).toBe(user.address);
  expect(swap.signer).toBe(wallet.address);
  // What `observe` will look for: shares arriving at the user, not at any worker address.
  expect(swap.evidence).toEqual({ token: asset.token, recipient: wallet.address, amount: MIN_OUT });
});

test("a wallet the user has not delegated cannot be signed from", async () => {
  // Removing the delegation in Privy is how a user withdraws consent, and it has to bite on
  // the very next order — before any balance is read or any calldata is built.
  const c = chain({ delegated: false });
  healthy(c);
  const { context, order } = await fixture();
  await expect(c.prepare("approve", order, context)).rejects.toThrow(
    "Automatic buying is not enabled",
  );
  expect(c.client.call).not.toHaveBeenCalled();
});

test("insufficient USDC in the user's wallet cancels the order rather than halting the strategy", async () => {
  // A plain Error: Lifecycle files it as a cancelled order and the strategy keeps running.
  // RecoveryRequired would halt the instance for an operator, and an empty wallet is not an
  // operator's problem.
  const c = chain();
  healthy(c, { cash: 1n });
  const { context, order } = await fixture();
  const error: unknown = await c.prepare("approve", order, context).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RecoveryRequired);
  expect((error as Error).message).toContain("Not enough USDC");
});

test("an unknown pending transaction on the user's wallet halts for recovery", async () => {
  // The wallet is the user's own, so a pending nonce nobody journaled may be theirs. Signing
  // over it would race them for the nonce; the safe move is to stop and let someone look.
  const c = chain();
  healthy(c, { pending: 8 });
  const { context, order } = await fixture();
  await expect(c.prepare("approve", order, context)).rejects.toBeInstanceOf(RecoveryRequired);
  await expect(c.prepare("approve", order, context)).rejects.toThrow("unknown pending");
});

test("unknown hash with consumed nonce is ambiguous, not successful or safe to retry", async () => {
  const c = chain();
  const hash = `0x${"33".repeat(32)}` as const;
  spyOn(c.client, "getChainId").mockResolvedValue(8453);
  spyOn(c.client, "getTransactionReceipt").mockRejectedValue(
    new TransactionReceiptNotFoundError({ hash }),
  );
  spyOn(c.client, "getTransactionCount").mockResolvedValue(8);
  expect(await c.observe({ hash, signer: wallet.address, nonce: 7 } as TransactionRow)).toBe(
    "ambiguous",
  );
});

test("disabled execution and altered journal bytes cannot reach broadcast", async () => {
  const tx = {
    rawTransaction: "0x1234",
    hash: `0x${"00".repeat(32)}`,
    signer: wallet.address,
  } as TransactionRow;
  // Off means no signer at all, not a signer that refuses: the process never held one.
  const disabled = chain({ execute: false });
  expect(disabled.signer).toBeUndefined();
  await expect(disabled.broadcast(tx)).rejects.toThrow("Invalid journal");
  await expect(chain().broadcast(tx)).rejects.toThrow("Invalid journal");
});
