import { Problem } from "@mandate/contracts";
import { Decimal } from "decimal.js";

// Same construction the strategy package uses for money: enough precision to hold a
// 78-digit raw integer exactly, and truncation rather than half-up so no arithmetic here
// can invent value that the chain will not pay out.
const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });

export type Side = "buy" | "sell";

/** USDC on Base. Fixed here so the quote leg's scale is never inferred from an asset. */
export const QUOTE_DECIMALS = 6;

/**
 * 5%, matching the published API contract.
 *
 * This band is a mispricing detector, not a slippage limit. The two failures it sits
 * between are far apart: a $100k order on the healthy AAPLc/USDC pool moves the price
 * 0.17%, so 500bps leaves roughly 29x headroom for legitimate impact, while the failure it
 * must catch — the same pair quoted at tick spacing 200 — is 11,729% off. Tightening it
 * toward the impact number would start refusing real large orders; widening it buys
 * nothing, because nothing between 5% and 117x is what goes wrong here. Execution slippage
 * is bounded separately and in integers by `minOut`.
 */
export const SANITY_BAND_BPS = 500;

export type RouteCandidate = {
  tickSpacing: number;
  amountOut: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
};

export type RouteRejectionReason =
  | "no-route"
  | "empty-quote"
  | "outside-band"
  | "invalid-price"
  | "upstream";

export type RouteRejection = {
  tickSpacing: number;
  reason: RouteRejectionReason;
  /** Present only for `outside-band`, so operators can see how far off the pool was. */
  deviationBps?: number;
};

export type AdmittedRoute = RouteCandidate & {
  /** USDC per whole share, decimal string. */
  impliedPrice: string;
  deviationBps: number;
};

export type RouteSelection = {
  best: AdmittedRoute;
  admitted: AdmittedRoute[];
  rejected: RouteRejection[];
};

/**
 * Price a fill in USDC per whole share, from raw integer amounts only.
 *
 * Three different scales meet here — AAPLc is 8 decimals (not 18), USDC is 6, and the
 * Chainlink answer is 8 — so every conversion is explicit and none of them is a float. An
 * object parameter rather than four positional arguments: two adjacent decimal counts in a
 * positional call is exactly how an order gets mis-sized by 10^2.
 */
export function impliedPrice(params: {
  side: Side;
  amountIn: bigint;
  amountOut: bigint;
  assetDecimals: number;
  quoteDecimals?: number;
}): string {
  const { side, amountIn, amountOut, assetDecimals } = params;
  const quoteDecimals = params.quoteDecimals ?? QUOTE_DECIMALS;
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 36)
    throw new Problem(
      400,
      "invalid-amount",
      "Invalid asset scale",
      "The asset's decimal scale is unusable.",
    );
  if (amountIn <= 0n || amountOut <= 0n)
    throw new Problem(
      400,
      "invalid-amount",
      "Invalid fill",
      "A price needs positive amounts on both legs.",
    );
  // On a buy, USDC goes in and shares come out; on a sell the legs swap. Getting this
  // backwards inverts the price and turns the band check into a rubber stamp.
  const usdcRaw = side === "buy" ? amountIn : amountOut;
  const shareRaw = side === "buy" ? amountOut : amountIn;
  const usdc = new Money(usdcRaw.toString()).div(new Money(10).pow(quoteDecimals));
  const shares = new Money(shareRaw.toString()).div(new Money(10).pow(assetDecimals));
  return usdc.div(shares).toFixed();
}

/**
 * Absolute deviation from the reference, in basis points, rounded AWAY from zero so that
 * a `<= band` comparison never admits something that is actually outside the band.
 */
export function deviationBps(implied: string, reference: string): number {
  const ref = new Money(reference);
  const price = new Money(implied);
  if (!ref.isFinite() || ref.lte(0) || !price.isFinite() || price.lte(0))
    throw Problem.unavailable("A usable reference price is required to check a route.");
  return price.div(ref).minus(1).abs().mul(10000).toDecimalPlaces(2, Decimal.ROUND_UP).toNumber();
}

/**
 * Choose a route.
 *
 * The band is applied to EVERY candidate before any comparison of outputs, and this
 * ordering is the whole point of the function. Best-output selection on its own is
 * directionally unsafe: the AAPLc/USDC pool at tick spacing 200 quotes $37,861 a share
 * against a $320.08 reference, so on a BUY it returns ~118x fewer tokens and max-output
 * discards it by luck, but on a SELL it returns ~118x more USDC and max-output actively
 * picks it — the user hands over real shares into an 11,729% mispricing. Validating only
 * the winner reproduces that bug exactly. Admission first, comparison second.
 */
export function selectRoute(params: {
  side: Side;
  amountIn: bigint;
  assetDecimals: number;
  reference: string;
  candidates: readonly RouteCandidate[];
  rejected?: readonly RouteRejection[];
  bandBps?: number;
  quoteDecimals?: number;
}): RouteSelection {
  const bandBps = params.bandBps ?? SANITY_BAND_BPS;
  if (!Number.isFinite(bandBps) || bandBps <= 0)
    throw new Error("selectRoute requires a positive sanity band");
  const rejected: RouteRejection[] = [...(params.rejected ?? [])];
  const admitted: AdmittedRoute[] = [];
  for (const candidate of params.candidates) {
    if (candidate.amountOut <= 0n) {
      rejected.push({ tickSpacing: candidate.tickSpacing, reason: "empty-quote" });
      continue;
    }
    let price: string;
    try {
      price = impliedPrice({
        side: params.side,
        amountIn: params.amountIn,
        amountOut: candidate.amountOut,
        assetDecimals: params.assetDecimals,
        ...(params.quoteDecimals === undefined ? {} : { quoteDecimals: params.quoteDecimals }),
      });
    } catch {
      rejected.push({ tickSpacing: candidate.tickSpacing, reason: "invalid-price" });
      continue;
    }
    const deviation = deviationBps(price, params.reference);
    if (deviation > bandBps) {
      rejected.push({
        tickSpacing: candidate.tickSpacing,
        reason: "outside-band",
        deviationBps: deviation,
      });
      continue;
    }
    admitted.push({ ...candidate, impliedPrice: price, deviationBps: deviation });
  }
  // Deterministic: largest output first, then the shallower fill, then the smaller tick
  // spacing. Two pools quoting identically must not select differently between runs, or a
  // re-quote before the swap leg silently changes the pool the order routes through.
  admitted.sort(
    (a, b) =>
      (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0) ||
      a.initializedTicksCrossed - b.initializedTicksCrossed ||
      a.tickSpacing - b.tickSpacing,
  );
  const best = admitted[0];
  if (!best) throw Problem.unavailable(explainNoRoute(rejected, bandBps));
  return { best, admitted, rejected };
}

/**
 * Distinguish "this pair has no liquidity" from "we could not reach the price source".
 * Both are 503, but conflating them sends an operator hunting for a pool that is fine
 * while the RPC is rate-limiting.
 */
function explainNoRoute(rejected: readonly RouteRejection[], bandBps: number): string {
  if (rejected.length === 0) return "No Aerodrome tick spacing was probed for this pair.";
  if (rejected.every((r) => r.reason === "upstream"))
    return "The Aerodrome price source could not be reached for any tick spacing.";
  const worst = rejected
    .filter((r) => r.reason === "outside-band")
    .reduce<number | undefined>(
      (max, r) =>
        r.deviationBps !== undefined && (max === undefined || r.deviationBps > max)
          ? r.deviationBps
          : max,
      undefined,
    );
  if (worst !== undefined)
    return `No Aerodrome quote within ${bandBps / 100}% of the reference price at this size; the closest usable pool was off by ${worst / 100}%.`;
  return "No Aerodrome pool has liquidity for this pair at this size.";
}

/**
 * Execution floor, in raw integer units.
 *
 * Pure bigint on purpose: this is the number that goes into `amountOutMinimum` on chain,
 * and no rounding mode may ever inflate it. Truncation loses at most one raw unit
 * (1e-6 USDC, or 1e-8 of a share) versus rounding up, which is immaterial next to the
 * revert an over-tight floor would cause on an exact-boundary fill.
 */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000)
    throw new Problem(
      400,
      "invalid-amount",
      "Invalid slippage",
      "Slippage must be a whole number of basis points between 0 and 10000.",
    );
  if (amountOut <= 0n)
    throw new Problem(
      400,
      "invalid-amount",
      "Invalid quote",
      "A minimum output needs a positive quoted output.",
    );
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
