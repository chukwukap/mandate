/**
 * Formatting helpers for money on screen.
 *
 * What used to live here was a market simulator: `demoQuote` wobbled a price with a sine wave so
 * a paper fill would "feel like a market", and `candlesFor` generated 64 candles from a seed.
 * Both are gone. Every price this app shows now comes from /v1/market and every candle from
 * /v1/market/candles, so there is nothing left to simulate and no fixture to drift against the
 * live reference — which is what happened last time: AAPLc pinned at 237.49 while the real
 * reference read 320.08, a 26% error shown to anyone evaluating the product.
 */

/** Cents to a dollar string. The ledger counts in cents; screens read in dollars. */
export const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(cents / 100);

/** A dollar string to whole cents, or 0 when it is not a well-formed amount. */
export function amountToCents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return 0;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}

/** A decimal string of dollars to a display string, for values the API sends as strings. */
export function money(value: string | null | undefined, fallback = "—") {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(parsed)
    : fallback;
}
