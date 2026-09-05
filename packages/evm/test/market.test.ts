import { expect, test } from "bun:test";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
  parseAbi,
} from "viem";
import { base } from "viem/chains";
import { QUOTER } from "../src/addresses/index.js";
import { ASSETS, BaseReader, USDC } from "../src/index.js";

const asset = (() => {
  const first = ASSETS[0];
  if (!first) throw new Error("Missing fixture asset");
  return first;
})();
const feedAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)",
]);
function setup(
  options: { stale?: boolean; missing?: boolean; chain?: string; outlier?: boolean } = {},
) {
  let reads = 0;
  const client = createPublicClient({
    chain: base,
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return options.chain ?? "0x2105";
          if (method !== "eth_call") throw new Error("Unexpected RPC method");
          reads++;
          const [{ to, data }] = params as [{ to: string; data: Hex }];
          if (to.toLowerCase() === asset.feed.toLowerCase()) {
            if (options.missing) throw new Error("Feed unavailable");
            const { functionName } = decodeFunctionData({ abi: feedAbi, data });
            if (functionName === "decimals")
              return encodeFunctionResult({ abi: feedAbi, functionName, result: 8 });
            const at = options.stale ? 1n : BigInt(Math.floor(Date.now() / 1000));
            return encodeFunctionResult({
              abi: feedAbi,
              functionName,
              result: [1n, 200_00000000n, at, at, 1n],
            });
          }
          if (to.toLowerCase() === asset.token.toLowerCase()) {
            const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
            if (functionName === "decimals")
              return encodeFunctionResult({ abi: erc20Abi, functionName, result: 8 });
            if (functionName === "symbol")
              return encodeFunctionResult({ abi: erc20Abi, functionName, result: asset.symbol });
            if (functionName === "totalSupply")
              return encodeFunctionResult({ abi: erc20Abi, functionName, result: 1000000000000n });
          }
          if (to.toLowerCase() === QUOTER.toLowerCase()) {
            const { args } = decodeFunctionData({ abi: quoterAbi, data });
            const q = args[0];
            const buy = q.tokenIn.toLowerCase() === USDC.toLowerCase();
            expect(q.tokenOut.toLowerCase()).toBe((buy ? asset.token : USDC).toLowerCase());
            const ideal = buy ? (q.amountIn * 100n) / 200n : (q.amountIn * 200n) / 100n;
            const out = options.outlier
              ? ideal / 100n
              : q.tickSpacing === 10
                ? ideal
                : (ideal * 98n) / 100n;
            return encodeFunctionResult({
              abi: quoterAbi,
              functionName: "quoteExactInputSingle",
              result: [out, 0n, 0, 100000n],
            });
          }
          throw new Error("Unexpected contract");
        },
      },
      { retryCount: 0 },
    ),
  });
  return { reader: new BaseReader(client, [asset]), reads: () => reads };
}
test("buy and reverse sell routing preserve raw-unit precision and select best output", async () => {
  const { reader } = setup();
  const buy = await reader.quote(asset, "buy", "10", 50);
  expect(buy.amount_in).toBe("10000000");
  expect(buy.amount_out).toBe("5000000");
  expect(buy.min_out).toBe("4975000");
  expect(buy.tick_spacing).toBe(10);
  const sell = await reader.quote(asset, "sell", "1", 50);
  expect(sell.amount_in).toBe("100000000");
  expect(sell.amount_out).toBe("200000000");
  expect(sell.tick_spacing).toBe(10);
});
test("missing/stale references and extreme price impact cannot produce quotes", async () => {
  for (const options of [{ stale: true }, { missing: true }, { outlier: true }]) {
    await expect(setup(options).reader.quote(asset, "buy", "10", 50)).rejects.toMatchObject({
      status: 503,
    });
  }
});
test("input precision is rejected instead of silently rounded", async () => {
  await expect(setup().reader.quote(asset, "buy", "0.0000001", 50)).rejects.toMatchObject({
    status: 400,
  });
  await expect(setup().reader.quote(asset, "sell", "0", 50)).rejects.toMatchObject({ status: 400 });
});
test("market cache coalesces requests and never represents unavailable data as zero", async () => {
  const { reader, reads } = setup();
  const [a, b] = await Promise.all([reader.market(), reader.market()]);
  expect(a).toEqual(b);
  expect(a[0]?.value).toBe("200");
  const count = reads();
  await reader.market();
  expect(reads()).toBe(count);
  const missing = await setup({ missing: true }).reader.market();
  expect(missing.every((feed) => feed.value === null && feed.stale)).toBe(true);
});
test("wrong network fails closed", async () => {
  await expect(setup({ chain: "0x1" }).reader.quote(asset, "buy", "10", 50)).rejects.toMatchObject({
    status: 503,
  });
});
