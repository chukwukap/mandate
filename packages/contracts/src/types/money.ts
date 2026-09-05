import type { Address, DecimalString, RawUnits, Side } from "./primitives.js";

/**
 * How an amount of money is represented as it crosses this system.
 *
 * There are exactly three representations and no fourth:
 *
 *   - `RawUnits`      an integer string in the token's smallest unit. What the chain moves,
 *                     what `executions.amount_in` stores, what the worker compares by exact
 *                     string equality before it will sign.
 *   - `bigint`        the same integer, in process, for arithmetic that must not lose a unit.
 *   - `DecimalString` whole units as a decimal string. What a user reads and what a signed
 *                     envelope's caps are written in.
 *
 * A JavaScript `number` is not on that list and never becomes one. 100.000001 USDC is exact
 * as a string and is not representable as a float64, and that value is a user's spend cap.
 *
 * Converting between the first and the third is `units()`/`whole()` in @mandate/strategy,
 * which is what actually enforces a signed envelope. It is deliberately not reimplemented
 * here: @mandate/strategy depends on this package, so importing it back would be circular,
 * and a second conversion that rounded differently from the one the caps were checked against
 * is precisely the bug that would let an order past a cap it should have failed.
 */

/** USDC. The quote token of every pair in this market, and the denomination of every cap. */
export const QUOTE_DECIMALS = 6;

/**
 * Every Coinbase B20 tokenized equity on Base — NVDAc, GOOGLc, AAPLc, METAc, MSFTc, AMZNc,
 * TSLAc — has 8 decimals. Not 18.
 *
 * This is a documented invariant of the catalogue, not a substitute for reading it: pricing
 * and order sizing must always use the asset's own `decimals` field, because that is what a
 * signed envelope committed to. The constant exists so a catalogue entry can be asserted
 * against it — a B20 token that ever reported something else would be a different token, and
 * silently pricing it with the assumed scale would be worse than failing.
 *
 * Assuming 18 here misprices an order by 1e10: a sell of 1 AAPLc becomes 0.00000001 shares.
 */
export const EQUITY_DECIMALS = 8;

/** ETH. Gas is reported in wei and shown in ETH; it is never taken from a user's permission. */
export const WEI_DECIMALS = 18;

/** One whole in basis points. A cap expressed as a fraction of equity is `bps / 10_000`. */
export const BPS_SCALE = 10_000;

/**
 * A signed basis-point measurement rendered as a string, two decimal places.
 *
 * A string rather than a number because these are compared and displayed, never accumulated,
 * and because "-0.00" — which is what a float64 produces for a tiny negative deviation —
 * reads to a user as a loss that did not happen. Producers round half-up and normalise
 * negative zero away before formatting.
 */
export type BpsString = string;

/** USDC per whole share, as a decimal string. The only price convention in this system. */
export type Price = DecimalString;

/**
 * Which side of a pair a value is denominated in.
 *
 * `quote` is always USDC and `base` is always the equity. Stated as a type because the
 * relationship flips with the order side, and a function that takes `(input, output)` without
 * naming which is which is how a buy's price ends up computed as shares-per-USDC.
 */
export type Denomination = "quote" | "base";

/**
 * A token's identity and scale, resolved against the envelope that was actually signed.
 *
 * `decimals` is nullable and that nullability is load-bearing: an address that belongs to
 * neither USDC nor this strategy's assets has no scale we are entitled to guess. Defaulting
 * to 18 would render a 1 AAPLc position as 0.00000001.
 */
export type TokenRef = {
  /** As stored, so the address round-trips to an explorer link unmodified. */
  token: Address;
  symbol: string | null;
  decimals: number | null;
};

/**
 * An amount of one token in both representations at once.
 *
 * `raw` is the durable value and is always present; `amount` is the rendering and is null when
 * either the raw value or the scale could not be trusted. Consumers that need to be exact —
 * a comparison, a sum, a re-signature — read `raw`. Only display reads `amount`.
 *
 * Structurally identical to the declaration in apps/api/src/modules/executions/pricing.ts,
 * which is what already ships this shape in execution responses; the two are mutually
 * assignable, so that module can re-export this one whenever it is convenient to do so.
 */
export type TokenAmount = TokenRef & {
  raw: RawUnits;
  /** Exact decimal string, or null when the raw value or the scale is unknown. */
  amount: DecimalString | null;
};

/**
 * The scale of the token an exact-input order spends.
 *
 * A buy spends USDC (6) and receives the equity; a sell spends the equity (8) and receives
 * USDC. Getting this backwards is a 10^2 error and assuming 18 is a 10^10 one, and the choice
 * is made independently in @mandate/strategy's `tick`, in the admission gate and in the market
 * catalogue — so it is written once here for all three to agree on.
 *
 * `assetDecimals` is the asset's own field, never `EQUITY_DECIMALS`: the envelope the user
 * signed carries the scale the order was authorized at.
 */
export function inputDecimals(side: Side, assetDecimals: number): number {
  return side === "buy" ? QUOTE_DECIMALS : assetDecimals;
}

/** The scale of the token the same order receives. The mirror of `inputDecimals`. */
export function outputDecimals(side: Side, assetDecimals: number): number {
  return side === "buy" ? assetDecimals : QUOTE_DECIMALS;
}

/**
 * Which leg of the pair each side of an exact-input order sits on.
 *
 * A buy pays quote for base; a sell pays base for quote. Both reduce to quote/base, which is
 * why one price function can serve both sides without two conventions drifting apart.
 */
export function denominations(side: Side): { input: Denomination; output: Denomination } {
  return side === "buy" ? { input: "quote", output: "base" } : { input: "base", output: "quote" };
}
