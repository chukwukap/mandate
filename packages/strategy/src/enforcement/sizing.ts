import { Money, units, whole } from "../evaluation/money.js";
import type { Asset, OrderSize, Side } from "../validation/schema.js";
import { positionKey } from "./allowlist.js";

/** USDC, the envelope's quote token, has six decimals. Admission encodes buys at 6. */
export const QUOTE_DECIMALS = 6;

export type Portfolio = {
  /** USDC balance plus oracle-valued allowlisted positions, as a decimal string. */
  equity: string;
  /** Lowercase token address to decimal balance. */
  positions: Record<string, string>;
  /**
   * Spendable USDC, when the observer supplies it. Optional because equity is not
   * spendable: a 100% pct_equity buy sizes against USDC *plus* stock, so without
   * this the over-sized buy is only discovered as a funding revert and a burnt fee.
   */
  quote?: string | undefined;
};

/** Integer decimals the order's input token is denominated in. A buy spends USDC; a sell sends stock. */
export function orderDecimals(asset: Asset, side: Side): number {
  return side === "buy" ? QUOTE_DECIMALS : asset.decimals;
}

export type ResolvedSize = {
  /** The exact decimal amount after flooring — what the caps are checked against. */
  amount: string;
  /** The same amount in integer token units — what is sent onchain. */
  raw: bigint;
  decimals: number;
};

/**
 * Turn an authored size into the exact amount that will be transferred.
 *
 * Every path floors to the input token's real decimals before anything else looks
 * at it. AAPLc has 8 decimals, not 18, and USDC has 6: a percentage of a position
 * lands on an unrepresentable fraction almost every time, and checking caps against
 * the unrounded number would admit an order whose onchain amount differs from the
 * one that was authorised.
 */
export function resolveSize(
  size: OrderSize,
  asset: Asset,
  side: Side,
  portfolio: Portfolio,
): ResolvedSize {
  const decimals = orderDecimals(asset, side);
  const amount =
    size.unit === "quote" || size.unit === "base"
      ? size.value
      : new Money(
          size.unit === "pct_equity"
            ? portfolio.equity
            : (portfolio.positions[positionKey(asset.token)] ?? "0"),
        )
          .mul(size.bps)
          .div(10_000)
          .toFixed();
  const raw = units(amount, decimals);
  return { amount: whole(raw, decimals), raw, decimals };
}
