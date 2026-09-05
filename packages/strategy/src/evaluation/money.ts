import { Decimal } from "decimal.js";

// One Decimal configuration for the whole system. 78 significant digits is the
// width of uint256 in base ten, so an integer token amount survives a round trip
// through Decimal exactly. ROUND_DOWN truncates toward zero, which means a
// division never invents a fraction of a token unit the account does not hold —
// the direction that under-spends rather than over-spends.
//
// Consequence worth knowing before changing it: truncation is lossy, so two
// mathematically equal expressions written differently can compare unequal under
// `eq`. Changing the rounding mode would silently change the behaviour of every
// already-signed strategy, so it is fixed here and nowhere else.
export const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });

/** Authored constants and parameters: what a human can reasonably write down. */
export const DECIMAL_PATTERN = /^-?\d{1,40}(\.\d{1,28})?$/;

// Live feed values are computed, not authored, and carry far more fraction digits
// than a constant. packages/evm/src/clients/base.ts derives `dex:SYM` as
// 10 / amount_out; for a ~$320 share that quotient prints roughly 75 fraction
// digits at precision 78. Holding a feed to the authored 28-digit limit would
// reject a perfectly good live price, so this guard is wider. Its job is to reject
// values decimal.js would misread — not to bound precision. Both producers
// (viem's formatUnits, and Decimal.toFixed) emit plain decimal notation only.
export const FEED_PATTERN = /^-?\d{1,40}(\.\d{1,80})?$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}
export function isFeedValue(value: unknown): value is string {
  return typeof value === "string" && FEED_PATTERN.test(value);
}

/**
 * Decimal string to integer token units, truncating at the token's real decimals.
 * AAPLc has 8 decimals and USDC has 6; assuming 18 here would inflate an order by
 * ten orders of magnitude, so callers must pass the asset's own value.
 */
export function units(value: string, decimals: number): bigint {
  const v = new Money(value);
  if (!v.isFinite() || v.isNegative()) throw new Error("Invalid token quantity");
  const raw = v.mul(new Money(10).pow(decimals)).floor();
  if (raw.gte(new Money(2).pow(256))) throw new Error("Token quantity overflow");
  return BigInt(raw.toFixed(0));
}

/** Integer token units back to a decimal string. Inverse of `units` for exact values. */
export function whole(value: bigint, decimals: number): string {
  return new Money(value.toString()).div(new Money(10).pow(decimals)).toFixed();
}
