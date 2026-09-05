import type { RouteCandidate, RouteRejection } from "../../../packages/evm/src/venues/sanity.js";
import { assetOf, TICK_SPACINGS } from "./catalogue.js";

/**
 * Recorded Aerodrome Slipstream quoter output, one entry per tick spacing.
 *
 * Tick spacing is the correctness trap this whole file exists for. The SAME AAPLc/USDC pair
 * quotes $320.22 a share at spacing 10 — 4.4 bps off a $320.08 NAV, and it absorbs $100k for
 * 0.17% — while at spacing 200 it quotes $37,861 a share, an 11,729% error, because that pool
 * is near empty and a `sqrtPriceLimitX96` of 0 lets the quoter walk the whole curve.
 *
 * The direction of the error is what makes it dangerous. On a BUY the trap returns ~118x
 * FEWER tokens, so picking the largest output discards it by luck. On a SELL it returns ~118x
 * MORE USDC, so picking the largest output actively selects it and the user hands over real
 * shares into the mispricing. Both directions are recorded below; `selectRoute` must refuse
 * the trap on each.
 */

export type ProbeOutcome =
  | {
      readonly kind: "fill";
      readonly amountOut: bigint;
      readonly initializedTicksCrossed: number;
      readonly gasEstimate: bigint;
    }
  /** The pool does not exist, or exists and reverts. Either way there is no route here. */
  | { readonly kind: "revert" }
  /** The RPC never answered. Not the same thing as an absent pool, and must never be read as one. */
  | { readonly kind: "upstream" };

export type RecordedProbe = { readonly tickSpacing: number } & ProbeOutcome;

export type QuoteFixture = {
  readonly id: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  /** Raw input amount, in the INPUT token's own decimals: 6 for a buy, 8 for a sell. */
  readonly amountIn: bigint;
  /** The Chainlink reference these probes are admitted against. */
  readonly reference: string;
  readonly probes: readonly RecordedProbe[];
  readonly note: string;
};

/** USDC micro-units per whole share. Six decimals on the quote leg, eight on the share leg. */
export type Pricebook = ReadonlyMap<number, bigint>;

/**
 * The venue as a flat price per spacing, used when no exact scene was recorded.
 *
 * This models a pool with no depth curve: the same price at any size. That is wrong for large
 * orders by construction, and deliberately so — a fixture that invented a plausible-looking
 * impact curve would be asserting fiction. When impact matters, use a recorded scene, which
 * carries the measured fill. An empty pricebook means every spacing reverts.
 */
export const PRICEBOOKS: Readonly<Record<string, Pricebook>> = {
  AAPLc: new Map([
    [10, 320_220_000n],
    // The trap. Left in on purpose: a fixture that quietly dropped it would let a regression
    // in route admission pass every test in this repository.
    [200, 37_861_000_000n],
  ]),
  GOOGLc: new Map([[50, 241_550_000n]]),
  METAc: new Map([[100, 612_610_000n]]),
  NVDAc: new Map([
    [100, 177_860_000n],
    // A second real pool, priced worse. Best-output selection has to actually choose.
    [2000, 178_400_000n],
  ]),
  // No pools. MSFTc is a deployed B20 equity that this system does not route: a live
  // reference price and no executable venue at any spacing.
  MSFTc: new Map(),
  AMZNc: new Map([[100, 231_800_000n]]),
  TSLAc: new Map([[100, 440_900_000n]]),
};

/** Every spacing not named in a scene reverted. Written once rather than six times per scene. */
function withReverts(filled: readonly RecordedProbe[]): RecordedProbe[] {
  const named = new Set(filled.map((probe) => probe.tickSpacing));
  return [
    ...filled,
    ...TICK_SPACINGS.filter((spacing) => !named.has(spacing)).map(
      (tickSpacing) => ({ tickSpacing, kind: "revert" }) as const,
    ),
  ];
}

const fill = (
  tickSpacing: number,
  amountOut: bigint,
  initializedTicksCrossed: number,
  gasEstimate = 121_000n,
): RecordedProbe => ({
  tickSpacing,
  kind: "fill",
  amountOut,
  initializedTicksCrossed,
  gasEstimate,
});

export const QUOTES: readonly QuoteFixture[] = [
  {
    id: "aaplc-buy-10-usdc",
    symbol: "AAPLc",
    side: "buy",
    amountIn: 10_000_000n,
    reference: "320.08",
    // 0.03122852 AAPLc for 10 USDC is $320.2201/share. This is byte-identical to the fill
    // apps/api/test/market.test.ts records, so the catalogue row a test builds from this
    // fixture and the one that test builds by hand cannot disagree.
    probes: withReverts([fill(10, 3_122_852n, 3), fill(200, 26_412n, 4_000, 402_000n)]),
    note: "The probe size GET /v1/market uses. Healthy pool at spacing 10; the trap at 200 returns 118x fewer shares for the same USDC.",
  },
  {
    id: "aaplc-buy-100k-usdc",
    symbol: "AAPLc",
    side: "buy",
    amountIn: 100_000_000_000n,
    reference: "320.08",
    // $100k fills at 320.764 — 0.17% of price impact, 21 bps from the NAV. The 5% sanity band
    // has ~29x headroom over this, which is why it can be tight enough to catch the trap.
    probes: withReverts([fill(10, 31_175_568_330n, 11), fill(200, 264_124_032n, 4_000, 402_000n)]),
    note: "Real depth: a $100k order moves the healthy pool 0.17%. The band must admit this and still refuse the trap.",
  },
  {
    id: "aaplc-sell-1-share",
    symbol: "AAPLc",
    side: "sell",
    amountIn: 100_000_000n,
    reference: "320.08",
    probes: withReverts([
      fill(10, 320_220_000n, 3),
      // 37,861 USDC for one share. Unfiltered max-output picks THIS, not the honest pool.
      fill(200, 37_861_000_000n, 4_000, 402_000n),
    ]),
    note: "The dangerous direction. On a sell the trap wins on output, so admission has to happen per candidate before any comparison.",
  },
  {
    id: "nvdac-buy-10-usdc",
    symbol: "NVDAc",
    side: "buy",
    amountIn: 10_000_000n,
    reference: "177.85",
    probes: withReverts([fill(100, 5_622_399n, 2), fill(2000, 5_605_381n, 5)]),
    note: "Two live pools, both inside the band. Selection is a genuine comparison, not the only survivor.",
  },
  {
    id: "googlc-buy-10-usdc",
    symbol: "GOOGLc",
    side: "buy",
    amountIn: 10_000_000n,
    reference: "241.5",
    probes: withReverts([fill(50, 4_139_929n, 2)]),
    note: "A second healthy asset so multi-asset snapshots are not one asset repeated.",
  },
  {
    id: "msftc-buy-10-usdc",
    symbol: "MSFTc",
    side: "buy",
    amountIn: 10_000_000n,
    reference: "428.6",
    probes: withReverts([]),
    note: "Every spacing reverts. The reference is fine, so this must surface as 'no liquidity', never as 'no reference price'.",
  },
  {
    id: "aaplc-buy-10-usdc-rpc-down",
    symbol: "AAPLc",
    side: "buy",
    amountIn: 10_000_000n,
    reference: "320.08",
    probes: TICK_SPACINGS.map((tickSpacing) => ({ tickSpacing, kind: "upstream" }) as const),
    note: "A rate-limited or unreachable RPC. Arrives through allSettled looking exactly like a revert; reading it as an absent pool makes a degraded endpoint look like a dead pair.",
  },
];

export function quoteOf(id: string): QuoteFixture {
  const fixture = QUOTES.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`No quote fixture ${id}`);
  return fixture;
}

/** Exact-integer fill at a flat price. Buys receive shares; sells receive USDC. */
export function fillAt(params: {
  side: "buy" | "sell";
  amountIn: bigint;
  priceMicroUsdc: bigint;
  assetDecimals: number;
}): bigint {
  const scale = 10n ** BigInt(params.assetDecimals);
  return params.side === "buy"
    ? (params.amountIn * scale) / params.priceMicroUsdc
    : (params.amountIn * params.priceMicroUsdc) / scale;
}

/**
 * The probes a symbol/side/size would return.
 *
 * An exactly recorded scene wins; otherwise the pricebook synthesises a flat-price fill at
 * every spacing that has a pool. Anything the pricebook does not name reverts, which is the
 * honest answer: four of the six spacings genuinely have no pool for these pairs.
 */
export function probesFor(params: {
  symbol: string;
  side: "buy" | "sell";
  amountIn: bigint;
}): readonly RecordedProbe[] {
  const recorded = QUOTES.find(
    (entry) =>
      entry.symbol === params.symbol &&
      entry.side === params.side &&
      entry.amountIn === params.amountIn,
  );
  if (recorded) return recorded.probes;
  const pricebook = PRICEBOOKS[params.symbol];
  if (!pricebook) throw new Error(`No pricebook for ${params.symbol}`);
  const decimals = assetOf(params.symbol).decimals;
  return withReverts(
    [...pricebook.entries()]
      .map(([tickSpacing, priceMicroUsdc]) => {
        const amountOut = fillAt({
          side: params.side,
          amountIn: params.amountIn,
          priceMicroUsdc,
          assetDecimals: decimals,
        });
        // A fill that rounds to zero is not a fill. The quoter reverts rather than
        // returning 0, and `selectRoute` would otherwise record it as `empty-quote`.
        return amountOut > 0n
          ? fill(tickSpacing, amountOut, tickSpacing === 200 ? 4_000 : 3)
          : ({ tickSpacing, kind: "revert" } as const);
      })
      .filter((probe) => probe.kind === "fill"),
  );
}

export type SplitProbes = {
  /** Ready for `selectRoute`: only the spacings that actually filled. */
  readonly candidates: RouteCandidate[];
  /** The spacings that did not, already classified the way `SlipstreamRouter.probe` does. */
  readonly rejected: RouteRejection[];
};

/**
 * Split recorded probes into the two lists `selectRoute` takes.
 *
 * The classification is the point: a revert becomes `no-route` and a transport failure becomes
 * `upstream`, so a fixture-driven test sees the same distinction the router draws from viem's
 * cause chain — and a 503 that says "the price source could not be reached" cannot be mistaken
 * for one that says "this pair has no liquidity".
 */
export function splitProbes(probes: readonly RecordedProbe[]): SplitProbes {
  const candidates: RouteCandidate[] = [];
  const rejected: RouteRejection[] = [];
  for (const probe of probes) {
    if (probe.kind === "fill")
      candidates.push({
        tickSpacing: probe.tickSpacing,
        amountOut: probe.amountOut,
        initializedTicksCrossed: probe.initializedTicksCrossed,
        gasEstimate: probe.gasEstimate,
      });
    else
      rejected.push({
        tickSpacing: probe.tickSpacing,
        reason: probe.kind === "revert" ? "no-route" : "upstream",
      });
  }
  return { candidates, rejected };
}
