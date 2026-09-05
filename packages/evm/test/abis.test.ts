import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type AbiFunction,
  encodeFunctionData,
  type Hex,
  parseAbi,
  toFunctionSelector,
} from "viem";
import {
  aggregatorV3Abi,
  b20OracleRegistryAbi,
  b20PolicyRegistryAbi,
  b20TokenAbi,
  clFactoryAbi,
  clPoolAbi,
  erc20Abi,
  quoterV2Abi,
  spendPermissionManagerAbi,
  spendPermissionParameter,
  swapRouterAbi,
} from "../src/abis/index.js";
import { permissionTypes } from "../src/permissions/index.js";

/**
 * These ABIs are copies. Until callers are rewired, the same signatures also live in
 * clients/base.ts, permissions/index.ts and apps/worker/src/chain.ts, and a one-sided edit
 * to any of them diverges silently and only fails on Base mainnet. So rather than trusting
 * the copies, this test reads the other files' source and compares the encodings they
 * actually produce.
 */
function repoAbi(relativePath: string, constName: string): Abi {
  const source = readFileSync(join(import.meta.dir, relativePath), "utf8");
  const start = source.indexOf(`const ${constName} = parseAbi([`);
  if (start < 0) throw new Error(`${constName} not found in ${relativePath}`);
  const end = source.indexOf("]);", start);
  const signatures = [
    ...source.slice(start, end).matchAll(/"((?:struct|function|event) [^"]*)"/g),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  if (signatures.length === 0) throw new Error(`${constName} had no signatures`);
  return parseAbi(signatures) as Abi;
}

function fn(abi: Abi, name: string): AbiFunction {
  const item = abi.find((entry) => entry.type === "function" && entry.name === name);
  if (!item) throw new Error(`missing function ${name}`);
  return item as AbiFunction;
}

const selector = (abi: Abi, name: string) => toFunctionSelector(fn(abi, name));

test("ERC20, Chainlink and CLPool selectors match the deployed 4-byte constants", () => {
  // Pinned so an edit to the signature strings above fails here rather than on mainnet.
  const pinned: [Abi, string, Hex][] = [
    [erc20Abi as Abi, "transfer", "0xa9059cbb"],
    [erc20Abi as Abi, "approve", "0x095ea7b3"],
    [erc20Abi as Abi, "balanceOf", "0x70a08231"],
    [erc20Abi as Abi, "allowance", "0xdd62ed3e"],
    [erc20Abi as Abi, "totalSupply", "0x18160ddd"],
    [erc20Abi as Abi, "decimals", "0x313ce567"],
    [aggregatorV3Abi as Abi, "latestRoundData", "0xfeaf968c"],
    [aggregatorV3Abi as Abi, "decimals", "0x313ce567"],
    [aggregatorV3Abi as Abi, "description", "0x7284e416"],
    [aggregatorV3Abi as Abi, "getRoundData", "0x9a6fc8f5"],
    [clPoolAbi as Abi, "liquidity", "0x1a686502"],
    [clPoolAbi as Abi, "token0", "0x0dfe1681"],
    [clPoolAbi as Abi, "token1", "0xd21220a7"],
    [clPoolAbi as Abi, "fee", "0xddca3f43"],
    [clPoolAbi as Abi, "tickSpacing", "0xd0c93a7c"],
  ];
  for (const [abi, name, expected] of pinned) expect(selector(abi, name)).toBe(expected);
});

test("Slipstream is keyed by tickSpacing, not by the Uniswap V3 fee", () => {
  // getPool(address,address,int24) vs Uniswap V3's getPool(address,address,uint24).
  // Pasting the V3 ABI compiles and then reverts on chain with no useful message.
  expect(selector(clFactoryAbi as Abi, "getPool")).toBe("0x28af8d0b");
  expect(toFunctionSelector("function getPool(address,address,uint24)")).toBe("0x1698ee82");
  expect(selector(clFactoryAbi as Abi, "getPool")).not.toBe(
    toFunctionSelector("function getPool(address,address,uint24)"),
  );
  // The router's param struct has no `fee` member at all.
  const params = fn(swapRouterAbi as Abi, "exactInputSingle").inputs[0];
  const components = params && "components" in params ? params.components : [];
  expect(components.map((c) => c.name)).toEqual([
    "tokenIn",
    "tokenOut",
    "tickSpacing",
    "recipient",
    "deadline",
    "amountIn",
    "amountOutMinimum",
    "sqrtPriceLimitX96",
  ]);
});

test("QuoterV2 stays nonpayable so callers cannot reach for readContract", () => {
  // quoteExactInputSingle executes the swap and reverts to unwind; it must be simulated.
  expect(fn(quoterV2Abi as Abi, "quoteExactInputSingle").stateMutability).toBe("nonpayable");
  expect(fn(clFactoryAbi as Abi, "getPool").stateMutability).toBe("view");
  expect(fn(clPoolAbi as Abi, "liquidity").stateMutability).toBe("view");
});

test("the quoter and router copies elsewhere in the repo still encode identically", () => {
  const baseQuoter = repoAbi("../src/clients/base.ts", "quoterAbi");
  const workerAbi = repoAbi("../../../apps/worker/src/chain.ts", "abi");
  expect(selector(quoterV2Abi as Abi, "quoteExactInputSingle")).toBe(
    selector(baseQuoter, "quoteExactInputSingle"),
  );
  expect(selector(swapRouterAbi as Abi, "exactInputSingle")).toBe(
    selector(workerAbi, "exactInputSingle"),
  );
  for (const name of ["isPaused", "TRANSFER_RECEIVER_POLICY", "policyId"])
    expect(selector(b20TokenAbi as Abi, name)).toBe(selector(workerAbi, name));
  expect(selector(b20OracleRegistryAbi as Abi, "getOracleParams")).toBe(
    selector(workerAbi, "getOracleParams"),
  );
  expect(selector(b20PolicyRegistryAbi as Abi, "isAuthorized")).toBe(
    selector(workerAbi, "isAuthorized"),
  );
  expect(selector(aggregatorV3Abi as Abi, "latestRoundData")).toBe(
    selector(workerAbi, "latestRoundData"),
  );
});

test("the SpendPermission struct encodes identically to the copy the user signs", () => {
  const permissionAbi = repoAbi("../src/permissions/index.ts", "permissionAbi");
  const workerAbi = repoAbi("../../../apps/worker/src/chain.ts", "abi");
  const permission = {
    account: "0x1111111111111111111111111111111111111111",
    spender: "0x2222222222222222222222222222222222222222",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    allowance: 250_000_000n,
    period: 86_400,
    start: 1_700_000_000,
    end: 1_700_086_400,
    salt: 42n,
    extraData: "0x",
  } as const;
  const signature = "0xdeadbeef" as const;
  // Full calldata, not just the selector: a reordered struct with the same field types
  // would keep the selector and silently swap `spender` for `token`.
  expect(
    encodeFunctionData({
      abi: spendPermissionManagerAbi,
      functionName: "approveWithSignature",
      args: [permission, signature],
    }),
  ).toBe(
    encodeFunctionData({
      abi: permissionAbi,
      functionName: "approveWithSignature",
      args: [permission, signature],
    }),
  );
  expect(
    encodeFunctionData({
      abi: spendPermissionManagerAbi,
      functionName: "spend",
      args: [permission, 1_000_000n],
    }),
  ).toBe(
    encodeFunctionData({ abi: workerAbi, functionName: "spend", args: [permission, 1_000_000n] }),
  );
  expect(selector(spendPermissionManagerAbi as Abi, "getCurrentPeriod")).toBe(
    selector(workerAbi, "getCurrentPeriod"),
  );
});

test("the struct layout matches the EIP-712 type the wallet is asked to sign", () => {
  // The manager hashes the permission itself. If the calldata struct and the signed type
  // disagree, the user approves something the contract will never accept.
  const components =
    "components" in spendPermissionParameter ? spendPermissionParameter.components : [];
  expect(components.map((c) => ({ name: c.name, type: c.type }))).toEqual(
    permissionTypes.SpendPermission.map((field) => ({ name: field.name, type: field.type })),
  );
});
