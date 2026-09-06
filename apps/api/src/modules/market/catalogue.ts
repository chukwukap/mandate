import type { Asset, Hex, MarketFeed, Quote } from "@mandate/contracts";
import { MAX_VALIDATION_AGE } from "@mandate/evm";
import { Decimal } from "decimal.js";

// Token amounts and prices never touch binary floating point. AAPLc has 8 decimals and USDC
// has 6: a share price is (usdc_raw / 1e6) / (share_raw / 1e8), and float64 loses cents on
// that division long before a 78-digit decimal does. packages/strategy declares the identical
// clone at strategy.ts:6 but does not re-export it from its index, so the API keeps its own.
const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });

/** USDC is the quote token for every B20 pair the catalogue lists. */
export const QUOTE_DECIMALS = 6;
/**
 * Tradability is probed with a small exact-input buy. 10 USDC is deliberately the same size
 * BaseReader.assetMarket uses for its `dex:` feed, so the price in a catalogue entry and the
 * price in the `feeds` array of the same response are byte-for-byte identical instead of two
 * independent observations that can disagree.
 */
export const PROBE_NOTIONAL_USDC = "10";
export const PROBE_SLIPPAGE_BPS = 50;
/**
 * 500 bps == the 5% reference band BaseReader.route already enforces, restated here so a
 * different or degraded ChainReader can never get an out-of-band price labelled tradable.
 * With the real reader this bound is unreachable: the measured tick-spacing-200 AAPLc/USDC
 * pool quotes $37,861 against a $320 NAV (11,729% out) and is dropped before it reaches us.
 */
export const DEVIATION_LIMIT_BPS = 500;
export const SNAPSHOT_TTL_MS = 15_000;

/** Why an asset in the catalogue cannot be traded right now. Never omit the asset instead. */
export type MarketBlocker =
  | "reference-unavailable"
  | "reference-stale"
  | "no-priced-route"
  | "quote-deviation"
  | "chain-unavailable";

export type CatalogueQuote = {
  /** USDC per whole share implied by the probe, decimal string. */
  price: string;
  amount_in: string;
  amount_out: string;
  min_out: string;
  tick_spacing: number;
  expires_at: string;
};

export type CatalogueEntry = {
  symbol: string;
  token: Hex;
  feed: Hex;
  decimals: number;
  /** The reference price the verdict was made against, decimal string. */
  nav: string | null;
  /** Which reading `nav` came from: the quote's own reference, or the cached oracle feed. */
  nav_source: "quote" | "oracle" | null;
  /** Chainlink round timestamp in Unix seconds, from the oracle feed. 0 when unavailable. */
  nav_updated_at: number;
  nav_stale: boolean;
  quote: CatalogueQuote | null;
  /** Signed basis points of `quote.price` against `nav`, two decimals. */
  deviation_bps: string | null;
  tradable: boolean;
  reason: MarketBlocker | null;
  detail: string | null;
};

export type ProbeSpec = { side: "buy" | "sell"; amount: string; slippageBps: number };

export type EntryInput = {
  asset: Asset;
  /** The `oracle:<symbol>` feed from ChainReader.market(), when one was read. */
  feed?: MarketFeed | undefined;
  /** A successful probe, or null when the venue returned no usable route. */
  quote?: Quote | null | undefined;
  probe: ProbeSpec;
  /** True when the probe never ran: the chain was unreachable or the deadline passed. */
  unreachable?: boolean | undefined;
  limitBps?: number | undefined;
};

// A raw token amount is an unsigned integer string. Anything else (a float, a hex string, a
// negative) is a broken reader, not a number to coerce.
const RAW = /^\d{1,40}$/;
const DECIMAL = /^-?\d{1,40}(\.\d{1,40})?$/;

function fromRaw(value: string, decimals: number): Decimal | null {
  if (!RAW.test(value)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  // Dividing by a power of ten only shifts the exponent, so this stays exact.
  return new Money(value).div(new Money(10).pow(decimals));
}

function toDecimal(value: string | null | undefined): Decimal | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const parsed = new Money(value);
  return parsed.isFinite() ? parsed : null;
}

function impliedDecimal(
  asset: Asset,
  side: "buy" | "sell",
  amountIn: string,
  amountOut: string,
): Decimal | null {
  // Direction decides which leg carries the 6-decimal quote token and which carries the
  // 8-decimal share. Getting this backwards is a 10^2 error; assuming 18 decimals is 10^10.
  const shares = fromRaw(side === "buy" ? amountOut : amountIn, asset.decimals);
  const usdc = fromRaw(side === "buy" ? amountIn : amountOut, QUOTE_DECIMALS);
  if (!shares || !usdc || shares.lte(0) || usdc.lte(0)) return null;
  return usdc.div(shares);
}

/**
 * USDC per whole share implied by a filled quote, as a decimal string, or null when the
 * amounts cannot produce a finite positive price (a zero output, a non-integer raw amount).
 *
 * Quantised to USDC precision. `Money` keeps 78 significant digits so the division above never
 * rounds mid-calculation, but the published figure must not carry that: unrounded, this emits
 * values like 321.327674538766255967054916184889373308209793553395662333455866286557449532275,
 * which is not a price anyone can settle at, and a consumer parsing it as a float silently loses
 * the tail anyway. The deviation in `bps` is still computed from the FULL-precision decimal, so
 * rounding here changes what is displayed and never what is compared against the reference.
 *
 * Rounded rather than fixed-width: toFixed(6) would pad "400" into "400.000000" and change the
 * canonical form of every whole number on the wire. ROUND_DOWN matches `Money`, so a price can
 * never round up into a deviation band it did not actually reach.
 */
export function impliedPrice(
  asset: Asset,
  side: "buy" | "sell",
  amountIn: string,
  amountOut: string,
): string | null {
  return (
    impliedDecimal(asset, side, amountIn, amountOut)
      ?.toDecimalPlaces(QUOTE_DECIMALS, Decimal.ROUND_DOWN)
      .toFixed() ?? null
  );
}

/**
 * Whether a reading is past the age at which it can still anchor a deviation check.
 *
 * Shares MAX_VALIDATION_AGE with the chain client so the explanation the API gives and the rule
 * the venue enforces cannot drift apart — two constants for one decision is how a user gets told
 * one thing while the system does another.
 *
 * Only consulted once the reader has already called the feed stale, so this narrows a reason
 * rather than inventing one: a reader that reports a reading fresh is believed, and age here
 * only separates "too old to be a live price" from "too old to anchor a check at all".
 */
function referenceTooOldToValidate(feed: MarketFeed): boolean {
  if (!feed.updated_at) return true;
  return Math.floor(Date.now() / 1000) - feed.updated_at > MAX_VALIDATION_AGE;
}

function bps(price: Decimal, nav: Decimal): Decimal | null {
  // A zero or negative reference is not a divisor. BaseReader rejects answer <= 0 upstream,
  // so reaching here means a different reader handed us something unusable.
  if (nav.lte(0)) return null;
  const value = price.minus(nav).div(nav).times(10_000);
  return value.isFinite() ? value : null;
}

function formatBps(value: Decimal) {
  const rounded = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  // -0.004 bps must print as "0.00", never "-0.00".
  return (rounded.isZero() ? new Money(0) : rounded).toFixed(2);
}

/** Render a price for a human sentence. The wire value keeps full precision; prose does not. */
function short(value: string) {
  return new Money(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed();
}

/** Signed deviation of a price against a reference, in basis points to two decimals. */
export function deviationBps(price: string, nav: string): string | null {
  const p = toDecimal(price);
  const n = toDecimal(nav);
  if (!p || !n) return null;
  const value = bps(p, n);
  return value ? formatBps(value) : null;
}

export type PriceCheck = { price: string; deviation_bps: string; within: boolean };

/**
 * The single price/deviation computation shared by the catalogue and the quote route, so the
 * two can never disagree about whether the same fill is inside the band. `within` is decided
 * on the unrounded deviation: 500.004 bps is outside the limit even though it prints "500.00".
 */
export function priceCheck(
  asset: Asset,
  side: "buy" | "sell",
  amountIn: string,
  amountOut: string,
  reference: string,
  limitBps: number = DEVIATION_LIMIT_BPS,
): PriceCheck | null {
  const price = impliedDecimal(asset, side, amountIn, amountOut);
  const nav = toDecimal(reference);
  if (!price || !nav) return null;
  const value = bps(price, nav);
  if (!value) return null;
  return {
    // Published rounded; `value` above was computed from the full-precision decimal, so the
    // deviation check is unaffected by this.
    price: price.toDecimalPlaces(QUOTE_DECIMALS, Decimal.ROUND_DOWN).toFixed(),
    deviation_bps: formatBps(value),
    within: value.abs().lte(limitBps),
  };
}

function blocked(
  base: Omit<CatalogueEntry, "tradable" | "reason" | "detail">,
  reason: MarketBlocker,
  detail: string,
): CatalogueEntry {
  return { ...base, tradable: false, reason, detail };
}

/**
 * Compose one catalogue row. Pure: every chain read has already happened. An asset that cannot
 * be traded is still returned, with a reason code and a sentence the UI can show, because a
 * silently missing symbol is indistinguishable from a symbol that was never configured.
 */
export function catalogueEntry(input: EntryInput): CatalogueEntry {
  const { asset, feed, quote, probe } = input;
  const limitBps = input.limitBps ?? DEVIATION_LIMIT_BPS;
  // A reference of "0" parses but cannot divide, so it is no reference at all.
  const oracleReference = toDecimal(feed?.value);
  const oracleNav = oracleReference?.gt(0) ? (feed?.value ?? null) : null;
  const base = {
    symbol: asset.symbol,
    token: asset.token,
    feed: asset.feed,
    decimals: asset.decimals,
    nav: oracleNav,
    nav_source: oracleNav ? ("oracle" as const) : null,
    nav_updated_at: feed?.updated_at ?? 0,
    nav_stale: feed?.stale ?? true,
    quote: null,
    deviation_bps: null,
  } satisfies Omit<CatalogueEntry, "tradable" | "reason" | "detail">;

  if (input.unreachable)
    return blocked(
      base,
      "chain-unavailable",
      "Base could not be read in time, so this asset could not be priced. Try again shortly.",
    );

  if (!quote) {
    // No fill. The oracle tells us which of the three upstream failures the user is seeing.
    if (!oracleNav)
      return blocked(
        base,
        "reference-unavailable",
        "No verified Chainlink reference price is available for this asset.",
      );
    // Only when the reference is too old to VALIDATE against, which is a longer bound than
    // `stale`. `stale` merely means "not a live market price", and over a weekend that is true
    // of every equity feed while its pool trades normally. Reporting it as the blocker sent
    // users to look at Chainlink when the real answer was that MSFTc and AMZNc have no
    // Aerodrome route inside the deviation band — measured, on pools holding ~$150k.
    if (feed?.stale && referenceTooOldToValidate(feed))
      return blocked(
        base,
        "reference-stale",
        "The Chainlink reference price is older than this venue accepts, so no quote can be validated against it.",
      );
    return blocked(
      base,
      "no-priced-route",
      // The probe is exact-input, so the size is denominated in whichever token goes in.
      `No Aerodrome pool returned an executable ${probe.amount} ${probe.side === "buy" ? "USDC" : asset.symbol} ${probe.side} within ${limitBps} bps of the reference price.`,
    );
  }

  // The deviation is measured against the reference the quote itself was validated against,
  // not against the cached oracle feed, which can be up to 15s older. Mixing the two reports
  // clock skew between two caches as if it were venue mispricing.
  const checked = priceCheck(
    asset,
    probe.side,
    quote.amount_in,
    quote.amount_out,
    quote.reference,
    limitBps,
  );
  // "0" parses as a decimal but cannot divide. Only a strictly positive reference is one we
  // can measure against, so a zero or negative one falls back to the oracle reading.
  const quoteReference = toDecimal(quote.reference);
  const quoteNav = quoteReference?.gt(0) ? quote.reference : null;
  const priced = {
    ...base,
    // A fill exists, so the venue accepted the quote's own reference as fresh. Reporting the
    // cached oracle's staleness next to it would contradict the verdict we just made.
    ...(quoteNav ? { nav: quoteNav, nav_source: "quote" as const, nav_stale: false } : {}),
    quote: checked
      ? {
          price: checked.price,
          amount_in: quote.amount_in,
          amount_out: quote.amount_out,
          min_out: quote.min_out,
          tick_spacing: quote.tick_spacing,
          expires_at: quote.expires_at,
        }
      : null,
    deviation_bps: checked?.deviation_bps ?? null,
  } satisfies Omit<CatalogueEntry, "tradable" | "reason" | "detail">;

  if (!checked) {
    // Either the fill amounts cannot produce a price (a zero output) or the reference cannot
    // divide (zero, negative, non-numeric). Report the one that actually failed.
    if (!impliedDecimal(asset, probe.side, quote.amount_in, quote.amount_out))
      return blocked(
        priced,
        "no-priced-route",
        "The venue returned a fill with no usable output amount.",
      );
    return blocked(
      priced,
      "reference-unavailable",
      "The quote could not be checked against a verified reference price.",
    );
  }
  if (!checked.within)
    return blocked(
      priced,
      "quote-deviation",
      `The venue price ${short(checked.price)} is ${checked.deviation_bps} bps from the ${priced.nav} reference, beyond the ${limitBps} bps limit.`,
    );
  return { ...priced, tradable: true, reason: null, detail: null };
}
