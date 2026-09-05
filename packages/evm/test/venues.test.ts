import { expect, test } from "bun:test";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  parseAbi,
  RawContractError,
  zeroAddress,
} from "viem";
import { base } from "viem/chains";
import { ASSETS, QUOTER, TICK_SPACINGS } from "../src/addresses/index.js";
import { USDC } from "../src/permissions/index.js";
import {
  impliedPrice,
  minOut,
  SANITY_BAND_BPS,
  SLIPSTREAM_FACTORY,
  SLIPSTREAM_SWAP_ROUTER,
  SlipstreamRouter,
  selectRoute,
  toQuote,
} from "../src/venues/index.js";

const asset = (() => {
  const first = ASSETS[0];
  if (!first) throw new Error("Missing fixture asset");
  return first;
})();

// Declared independently of src/abis, so an ABI drift shows up here as a decode failure.
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)",
]);
const factoryAbi = parseAbi([
  "function getPool(address,address,int24) view returns (address)",
  "function liquidity() view returns (uint128)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
]);

/**
 * The measured AAPLc/USDC market on Base. Tick spacing 10 quotes $320.22 against a $320.08
 * Chainlink NAV; the SAME pair at tick spacing 200 quotes $37,861 a share — an 11,729%
 * error — because the pool is near empty and the quoter is free to walk the whole curve.
 * Prices are USDC micro-units per whole share.
 */
const REFERENCE = "320.08";
const PRICE_BY_SPACING = new Map<number, bigint>([
  [10, 320_220_000n],
  [200, 37_861_000_000n],
]);
const EMPTY_POOL = "0x00000000000000000000000000000000000dead2" as const;
const NOW_MS = 1_760_000_000_000;

type Mode = "measured" | "all-revert" | "upstream";

function harness(mode: Mode = "measured") {
  const client = createPublicClient({
    chain: base,
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x2105";
          if (method !== "eth_call") throw new Error("Unexpected RPC method");
          const [{ to, data }] = params as [{ to: Hex; data: Hex }];
          if (to.toLowerCase() === SLIPSTREAM_FACTORY.toLowerCase()) {
            const { args } = decodeFunctionData({ abi: factoryAbi, data });
            const spacing = args?.[2];
            // Only the trap pool was ever created; it holds nothing.
            return encodeFunctionResult({
              abi: factoryAbi,
              functionName: "getPool",
              result: spacing === 200 ? EMPTY_POOL : zeroAddress,
            });
          }
          if (to.toLowerCase() === EMPTY_POOL.toLowerCase())
            return encodeFunctionResult({
              abi: factoryAbi,
              functionName: "liquidity",
              result: 0n,
            });
          if (to.toLowerCase() !== QUOTER.toLowerCase()) throw new Error("Unexpected contract");
          // A plain Error is what pacedFetch throws when its queue is full. It must not be
          // mistaken for a revert.
          if (mode === "upstream") throw new Error("RPC request queue is full");
          const { args } = decodeFunctionData({ abi: quoterAbi, data });
          const q = args[0];
          const price = mode === "all-revert" ? undefined : PRICE_BY_SPACING.get(q.tickSpacing);
          // Pool exists on paper but reverts: this is "no route", not a fault.
          if (price === undefined) throw new RawContractError({ message: "execution reverted" });
          const buy = q.tokenIn.toLowerCase() === USDC.toLowerCase();
          const out = buy
            ? (q.amountIn * 10n ** BigInt(asset.decimals)) / price
            : (q.amountIn * price) / 10n ** BigInt(asset.decimals);
          return encodeFunctionResult({
            abi: quoterAbi,
            functionName: "quoteExactInputSingle",
            result: [out, 0n, q.tickSpacing === 200 ? 4000 : 3, 120_000n],
          });
        },
      },
      { retryCount: 0 },
    ),
  });
  return new SlipstreamRouter(client, { now: () => NOW_MS });
}

test("the tick-spacing trap is refused on a buy AND on a sell", async () => {
  const router = harness();
  const buy = await router.quoteExactInput({
    asset,
    side: "buy",
    amountIn: 1_000_000_000n,
    slippageBps: 50,
    reference: REFERENCE,
  });
  expect(buy.tickSpacing).toBe(10);
  expect(buy.amountOut).toBe(312_285_303n);
  expect(buy.minOut).toBe(310_723_876n);
  expect(buy.impliedPrice.startsWith("320.22")).toBe(true);
  expect(buy.deviationBps).toBeLessThan(SANITY_BAND_BPS);

  // The sell is the case naive best-output gets wrong: the trap pool returns ~118x MORE
  // USDC for the same share, so max-output actively selects it and the user hands over
  // shares into an 11,729% mispricing. The band must reject it before any comparison.
  const sell = await router.quoteExactInput({
    asset,
    side: "sell",
    amountIn: 100_000_000n,
    slippageBps: 50,
    reference: REFERENCE,
  });
  expect(sell.tickSpacing).toBe(10);
  expect(sell.amountOut).toBe(320_220_000n);
  expect(sell.minOut).toBe(318_618_900n);

  const trap = sell.rejected.find((r) => r.tickSpacing === 200);
  expect(trap?.reason).toBe("outside-band");
  expect(trap?.deviationBps ?? 0).toBeGreaterThan(1_000_000);
});

test("raw probe output shows exactly what max-output alone would have picked", async () => {
  const { candidates, rejected } = await harness().probe({
    tokenIn: asset.token,
    tokenOut: USDC,
    amountIn: 100_000_000n,
  });
  const byOutput = [...candidates].sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  // Unfiltered, the trap wins the sell outright — 37,861 USDC against 320.22 USDC.
  expect(byOutput[0]?.tickSpacing).toBe(200);
  expect(byOutput[0]?.amountOut).toBe(37_861_000_000n);
  // ...and selectRoute still refuses it, because admission happens per candidate first.
  expect(
    selectRoute({
      side: "sell",
      amountIn: 100_000_000n,
      assetDecimals: asset.decimals,
      reference: REFERENCE,
      candidates,
      rejected,
    }).best.tickSpacing,
  ).toBe(10);
  // The four spacings with no pool reverted and were recorded, not raised.
  expect(rejected.filter((r) => r.reason === "no-route")).toHaveLength(
    TICK_SPACINGS.length - PRICE_BY_SPACING.size,
  );
});

test("every spacing reverting is one 503 about liquidity, not six errors", async () => {
  const router = harness("all-revert");
  const { candidates, rejected } = await router.probe({
    tokenIn: USDC,
    tokenOut: asset.token,
    amountIn: 1_000_000_000n,
  });
  expect(candidates).toHaveLength(0);
  expect(rejected.every((r) => r.reason === "no-route")).toBe(true);
  try {
    await router.quoteExactInput({
      asset,
      side: "buy",
      amountIn: 1_000_000_000n,
      slippageBps: 50,
      reference: REFERENCE,
    });
    throw new Error("expected a refusal");
  } catch (error) {
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toContain("No Aerodrome pool has liquidity");
  }
});

test("a rate-limited RPC is an unavailable dependency, not an absent pool", async () => {
  const router = harness("upstream");
  const { rejected } = await router.probe({
    tokenIn: USDC,
    tokenOut: asset.token,
    amountIn: 1_000_000_000n,
  });
  // The whole point: a transport failure and a revert arrive identically through
  // allSettled, and misreading one as the other makes a degraded RPC look like a dead pair.
  expect(rejected.every((r) => r.reason === "upstream")).toBe(true);
  try {
    await router.quoteExactInput({
      asset,
      side: "buy",
      amountIn: 1_000_000_000n,
      slippageBps: 50,
      reference: REFERENCE,
    });
    throw new Error("expected a refusal");
  } catch (error) {
    expect((error as Error).message).toContain("could not be reached");
  }
});

test("pool existence is not liquidity", async () => {
  const pools = await harness().pools(asset.token, USDC);
  const trap = pools.find((pool) => pool.tickSpacing === 200);
  expect(trap).toEqual({
    tickSpacing: 200,
    pool: EMPTY_POOL,
    liquidity: 0n,
    status: "empty",
  });
  // A zero factory address short-circuits: reading liquidity() there returns empty data,
  // which viem raises as a decode error rather than the "no pool" it actually means.
  expect(pools.filter((pool) => pool.status === "missing")).toHaveLength(TICK_SPACINGS.length - 1);
  expect(pools.some((pool) => pool.status === "unreadable")).toBe(false);
});

test("the band admits real price impact and rejects the mispricing", () => {
  const candidate = (tickSpacing: number, amountOut: bigint) => ({
    tickSpacing,
    amountOut,
    initializedTicksCrossed: 3,
    gasEstimate: 120_000n,
  });
  // A $100k order moves the healthy pool 0.17%; the band has ~29x headroom for that.
  const impacted = (1_000_000_000n * 10n ** 8n) / 320_764_000n;
  const selection = selectRoute({
    side: "buy",
    amountIn: 1_000_000_000n,
    assetDecimals: asset.decimals,
    reference: REFERENCE,
    candidates: [candidate(10, impacted)],
  });
  expect(selection.best.deviationBps).toBeLessThan(50);
  // Boundary, priced exactly: 320.08 * 1.05 = 336.084, so one whole share bought for
  // 336.084 USDC sits precisely on the edge and the `<= band` comparison admits it.
  const edge = selectRoute({
    side: "buy",
    amountIn: 336_084_000n,
    assetDecimals: asset.decimals,
    reference: REFERENCE,
    candidates: [candidate(10, 100_000_000n)],
  });
  expect(edge.best.deviationBps).toBe(SANITY_BAND_BPS);
  // One micro-USDC past the edge is refused: the reported deviation rounds away from zero
  // so nothing outside 5% can slip in on a rounding artefact.
  expect(() =>
    selectRoute({
      side: "buy",
      amountIn: 336_085_000n,
      assetDecimals: asset.decimals,
      reference: REFERENCE,
      candidates: [candidate(10, 100_000_000n)],
    }),
  ).toThrow();
  expect(() =>
    selectRoute({
      side: "buy",
      amountIn: 1_000_000_000n,
      assetDecimals: asset.decimals,
      reference: REFERENCE,
      candidates: [candidate(10, (1_000_000_000n * 10n ** 8n) / 340_000_000n)],
    }),
  ).toThrow();
});

test("prices come from raw integers and the asset's own 8 decimals", () => {
  const at8 = impliedPrice({
    side: "buy",
    amountIn: 1_000_000_000n,
    amountOut: 312_285_303n,
    assetDecimals: 8,
  });
  expect(at8.startsWith("320.22")).toBe(true);
  // AAPLc is 8 decimals, NOT 18. Assuming 18 mis-sizes the order by 10^10.
  const at18 = impliedPrice({
    side: "buy",
    amountIn: 1_000_000_000n,
    amountOut: 312_285_303n,
    assetDecimals: 18,
  });
  expect(Number(at18) / Number(at8)).toBeCloseTo(1e10, -5);
  // A sell of the same fill prices identically once the legs are swapped.
  expect(
    impliedPrice({
      side: "sell",
      amountIn: 100_000_000n,
      amountOut: 320_220_000n,
      assetDecimals: 8,
    }),
  ).toBe("320.22");
});

test("the slippage floor is integer arithmetic that cannot round upward", () => {
  expect(minOut(312_285_303n, 0)).toBe(312_285_303n);
  expect(minOut(312_285_303n, 50)).toBe(310_723_876n);
  expect(minOut(10_000n, 10_000)).toBe(0n);
  // Truncation, never rounding: 9999 * 0.9999 = 9998.0001 must floor to 9998.
  expect(minOut(9_999n, 1)).toBe(9_998n);
  for (const bad of [-1, 10_001, 12.5, Number.NaN]) expect(() => minOut(1_000n, bad)).toThrow();
  expect(() => minOut(0n, 50)).toThrow();
});

test("the swap call carries a real floor and puts tickSpacing where V3 puts fee", () => {
  const router = harness();
  const call = router.exactInputSingleCall({
    tokenIn: USDC,
    tokenOut: asset.token,
    tickSpacing: 10,
    recipient: "0x1111111111111111111111111111111111111111",
    deadline: Math.floor(NOW_MS / 1000) + 20,
    amountIn: 1_000_000_000n,
    amountOutMinimum: 310_723_876n,
  });
  expect(call.to).toBe(SLIPSTREAM_SWAP_ROUTER);
  expect(call.chain_id).toBe(8453);
  expect(call.value).toBe("0");
  const { args } = decodeFunctionData({ abi: routerAbi, data: call.data });
  expect(args[0]).toMatchObject({
    tickSpacing: 10,
    amountIn: 1_000_000_000n,
    amountOutMinimum: 310_723_876n,
    sqrtPriceLimitX96: 0n,
  });
  // A zero floor is a swap that accepts any output at all. There is no legitimate reason
  // to sign one on Base mainnet, so it is refused rather than defaulted.
  const base = {
    tokenIn: USDC,
    tokenOut: asset.token,
    tickSpacing: 10,
    recipient: "0x1111111111111111111111111111111111111111" as const,
    deadline: Math.floor(NOW_MS / 1000) + 20,
    amountIn: 1_000_000_000n,
    amountOutMinimum: 310_723_876n,
  };
  expect(() => router.exactInputSingleCall({ ...base, amountOutMinimum: 0n })).toThrow();
  expect(() => router.exactInputSingleCall({ ...base, amountIn: 0n })).toThrow();
  expect(() => router.exactInputSingleCall({ ...base, tickSpacing: 0 })).toThrow();
  expect(() => router.exactInputSingleCall({ ...base, tokenOut: USDC })).toThrow();
  // An already-expired deadline would be mined into a guaranteed revert.
  expect(() =>
    router.exactInputSingleCall({ ...base, deadline: Math.floor(NOW_MS / 1000) }),
  ).toThrow();
});

test("the wire quote is integers and strings, and carries its own expiry", async () => {
  const route = await harness().quoteExactInput({
    asset,
    side: "buy",
    amountIn: 1_000_000_000n,
    slippageBps: 50,
    reference: REFERENCE,
  });
  expect(toQuote(route)).toEqual({
    token_in: USDC,
    token_out: asset.token,
    amount_in: "1000000000",
    amount_out: "312285303",
    min_out: "310723876",
    tick_spacing: 10,
    expires_at: new Date(NOW_MS + 20_000).toISOString(),
    reference: REFERENCE,
  });
});
