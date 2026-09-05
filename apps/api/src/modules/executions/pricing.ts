import { USDC } from "@mandate/evm";
import type { Envelope } from "@mandate/strategy";
import { whole } from "@mandate/strategy";
import { Decimal } from "decimal.js";

/**
 * Same clone as @mandate/strategy and modules/market: 78 significant digits, ROUND_DOWN.
 * @mandate/strategy does not export its `Money`, so it is reconstructed rather than imported;
 * the settings must stay identical or a price rendered here would disagree with the one the
 * caps were enforced against.
 */
const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });

/** `executions.amount_in` carries a CHECK for exactly this shape; evidence amounts do not. */
const RAW_INTEGER = /^[0-9]+$/;

export const QUOTE_DECIMALS = 6;
export const WEI_DECIMALS = 18;
/** Display scale for a USDC-per-share price. USDC itself only has six places. */
export const PRICE_DECIMALS = 6;

export type Side = "buy" | "sell";

export type TokenAmount = {
  /** As stored, so the address round-trips to an explorer link unmodified. */
  token: string;
  symbol: string | null;
  /**
   * Null when the address is neither USDC nor an asset of this strategy's signed envelope.
   * A guess would be catastrophic here: AAPLc, GOOGLc, METAc and NVDAc all have 8 decimals,
   * nothing in this market has 18, and formatting a sell of 1 AAPLc with a hardcoded 18
   * would render 0.00000001 shares instead of 1.
   */
  decimals: number | null;
  raw: string;
  /** Exact decimal string, or null when the raw value or the scale is unknown. */
  amount: string | null;
};

/**
 * Resolves a token's symbol and scale from the envelope the user actually signed.
 *
 * Deliberately not resolved against the global ASSETS catalogue: an execution belongs to one
 * signed strategy, and `intent.asset` is an index into `envelope.assets`, not into ASSETS.
 * Resolving by address keeps the two from being confused.
 */
export function tokenMeta(
  envelope: Envelope | undefined,
  token: string,
): { symbol: string | null; decimals: number | null } {
  const address = token.toLowerCase();
  if (address === USDC.toLowerCase()) return { symbol: "USDC", decimals: QUOTE_DECIMALS };
  const asset = envelope?.assets.find((a) => a.token.toLowerCase() === address);
  return asset
    ? { symbol: asset.symbol, decimals: asset.decimals }
    : { symbol: null, decimals: null };
}

export function tokenAmount(
  envelope: Envelope | undefined,
  token: string,
  raw: string,
): TokenAmount {
  const meta = tokenMeta(envelope, token);
  const known = RAW_INTEGER.test(raw) && meta.decimals !== null;
  return {
    token,
    symbol: meta.symbol,
    decimals: meta.decimals,
    raw,
    // whole() takes a bigint; BigInt() throws on anything but a numeric literal, so the raw
    // shape is checked first and an unparseable value reports itself rather than 500ing.
    amount: known ? whole(BigInt(raw), meta.decimals as number) : null,
  };
}

/** The asset an order is denominated in: the non-USDC side of the pair. */
export function baseOf(input: TokenAmount, output: TokenAmount | null, side: Side) {
  return side === "buy" ? output : input;
}

function decimalOf(value: string | null | undefined): Decimal | null {
  if (!value) return null;
  const parsed = new Money(value);
  return parsed.isFinite() ? parsed : null;
}

/**
 * USDC per share for either side.
 *
 * A buy pays `input` USDC for `output` shares; a sell delivers `input` shares for `output`
 * USDC. Both reduce to quote/base, so one function serves both and the two sides can never
 * drift into two different conventions.
 */
function unitPrice(side: Side, input: TokenAmount, output: TokenAmount | null): Decimal | null {
  const inValue = decimalOf(input.amount);
  const outValue = decimalOf(output?.amount);
  if (!inValue || !outValue) return null;
  const [quote, base] = side === "buy" ? [inValue, outValue] : [outValue, inValue];
  if (base.lte(0) || quote.lt(0)) return null;
  return quote.div(base);
}

const display = (value: Decimal | null) =>
  value === null ? null : value.toDecimalPlaces(PRICE_DECIMALS, Decimal.ROUND_HALF_UP).toFixed();

export type PriceDirection = "favourable" | "adverse" | "at_limit";

export type FillPricing = {
  /**
   * Always `guaranteed_minimum`. The durable record of the swap is `amountOutMinimum` — the
   * slippage floor the router was handed — not the quote's expected output, which the worker
   * never persists. Calling this "the quote" would overstate what is known.
   */
  basis: "guaranteed_minimum";
  quote_symbol: string | null;
  base_symbol: string | null;
  /** Worst price the router was permitted to give, in USDC per share. */
  guaranteed_price: string | null;
  /** Realised price, only ever derived from a transaction receipt. */
  filled_price: string | null;
  /** Signed difference of filled against guaranteed, in basis points, two decimal places. */
  difference_bps: string | null;
  /**
   * Which way that difference went for the user. Stated explicitly because the sign alone is
   * ambiguous across sides: on a buy a higher filled price is adverse, on a sell it is
   * favourable.
   */
  direction: PriceDirection | null;
};

export function fillPricing(
  side: Side,
  input: TokenAmount,
  guaranteed: TokenAmount | null,
  received: TokenAmount | null,
): FillPricing {
  const output = received ?? guaranteed;
  const base = baseOf(input, output, side);
  const guaranteedPrice = unitPrice(side, input, guaranteed);
  const filledPrice = unitPrice(side, input, received);
  let difference: string | null = null;
  let direction: PriceDirection | null = null;
  if (guaranteedPrice && filledPrice && guaranteedPrice.gt(0)) {
    const bps = filledPrice.minus(guaranteedPrice).div(guaranteedPrice).mul(10_000);
    const rounded = bps.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    // -0 renders as "-0.00" and reads as a loss that did not happen.
    difference = (rounded.isZero() ? new Money(0) : rounded).toFixed(2);
    // The router enforces amountOutMinimum, so a confirmed fill is at or better than the
    // floor and `adverse` should be unreachable. It is kept because reaching it means the
    // receipt disagrees with the transaction the worker signed, which a user must be shown.
    direction = rounded.isZero()
      ? "at_limit"
      : (side === "buy" ? rounded.isNegative() : rounded.isPositive())
        ? "favourable"
        : "adverse";
  }
  return {
    basis: "guaranteed_minimum",
    quote_symbol: (side === "buy" ? input : output)?.symbol ?? null,
    base_symbol: base?.symbol ?? null,
    guaranteed_price: display(guaranteedPrice),
    filled_price: display(filledPrice),
    difference_bps: difference,
    direction,
  };
}

export type GasCost = {
  /** gasUsed × effectiveGasPrice: the L2 execution fee. */
  l2_wei: string;
  /**
   * The OP-stack L1 data fee, which Base charges on top of L2 execution and which viem's
   * Base receipt formatter returns as `l1Fee`. Omitting it understates the real cost of the
   * transaction; on a quiet L1 it is small, but it is not zero and it has historically been
   * the larger half.
   */
  l1_wei: string;
  fee_wei: string;
  fee_eth: string;
};

export function gasCost(gasUsed: bigint, effectiveGasPrice: bigint, l1Fee: bigint): GasCost {
  const l2 = gasUsed * effectiveGasPrice;
  const total = l2 + l1Fee;
  return {
    l2_wei: l2.toString(),
    l1_wei: l1Fee.toString(),
    fee_wei: total.toString(),
    fee_eth: whole(total, WEI_DECIMALS),
  };
}

/** Totals the fee across an order's legs. The executor pays every one of them. */
export function addGas(a: GasCost, b: GasCost): GasCost {
  const l2 = BigInt(a.l2_wei) + BigInt(b.l2_wei);
  const l1 = BigInt(a.l1_wei) + BigInt(b.l1_wei);
  const total = l2 + l1;
  return {
    l2_wei: l2.toString(),
    l1_wei: l1.toString(),
    fee_wei: total.toString(),
    fee_eth: whole(total, WEI_DECIMALS),
  };
}

/** Sums USDC raw integers into a decimal string. Used for settled-spend aggregates. */
export function usdc(raw: bigint): string {
  return whole(raw, QUOTE_DECIMALS);
}

export function subtractUsdc(cap: string, spent: string): string {
  const remaining = new Money(cap).minus(new Money(spent));
  return (remaining.isNegative() ? new Money(0) : remaining).toFixed();
}
