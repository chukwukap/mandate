import { units, whole } from "@mandate/strategy";
import type { Leg } from "../lifecycle.js";
import { received, sent } from "./logs.js";
import { type ReceiptRecord, transactionCost } from "./receipts.js";

/**
 * What the order actually did, computed from receipts and from nothing else.
 *
 * The rule this module exists to enforce: a realised result is derived from settled
 * transfer logs, never from the quote that preceded them. A quote is a simulation of a
 * pool at a moment that has passed, and every way it can be wrong is a way that flatters
 * the result — it assumes the fill this order got, it ignores the gas that was burned
 * getting there, it ignores the gas burned on a leg that reverted, and it says nothing at
 * all about an order that funded and then stranded. Reporting `quote.amount_out` as
 * "shares received" produces a history in which nothing ever goes wrong.
 *
 * Two accounting facts are stated separately here rather than netted, because netting them
 * would make both wrong:
 *
 *  1. GAS IS THE OPERATOR'S COST, NOT THE USER'S. Fees are paid in ETH by the spender key
 *     and are never charged back (`docs/runbooks/worker-local.md`). Folding gas into a
 *     user's cost basis overstates what they paid; dropping it entirely hides what it costs
 *     to run the strategy. Both numbers exist below, and neither is silently converted into
 *     the other's currency — that would need an ETH/USD price, which is a market
 *     observation and not something an accounting function should invent.
 *  2. A BUY HAS NO REALISED P&L. What a completed buy realises is a cost basis and an
 *     execution quality. Any profit figure before the position is sold is a mark to market,
 *     which needs a current price, is unrealised, and is labelled as such in the type.
 */

/** Fixed-point scale for prices. 18 digits is far past any tick this market quotes. */
const PRICE_DECIMALS = 18;
/** USDC. Never inferred from an asset: it is the denominator of every price here. */
const QUOTE_DECIMALS = 6;

const TEN = 10n;
function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

/** One leg's receipt. Reverted legs belong here too: they cost gas and they explain state. */
export type SettledLeg = {
  readonly leg: Leg;
  readonly receipt: ReceiptRecord;
};

export type RealiseInput = {
  readonly side: "buy" | "sell";
  /** The user's strategy account: the origin of the input and the recipient of the output. */
  readonly account: string;
  /** The server-controlled spender wallet the input transits. See `../keys/custody.ts`. */
  readonly spender: string;
  readonly assetToken: string;
  /**
   * The asset's real scale. EVERY B20 equity is 8 decimals. Passing 18 here misprices the
   * fill by a factor of 10^10, and the number it produces is plausible enough to store.
   */
  readonly assetDecimals: number;
  readonly quoteToken: string;
  readonly quoteDecimals?: number | undefined;
  readonly legs: readonly SettledLeg[];
};

export type RealisedStatus =
  /** The swap settled. The account holds the asset. */
  | "filled"
  /** Funding never settled, so nothing left the account. */
  | "not-funded"
  /** The input was pulled and returned. The user paid nothing; the operator paid gas. */
  | "refunded"
  /** Funded, and neither swapped nor returned. The custodial window is still open. */
  | "stranded"
  /** No leg settled either way. */
  | "unsettled";

export type RealisedOrder = {
  readonly status: RealisedStatus;
  /** Quote units that left the user's account on the funding leg. */
  readonly accountSpent: bigint;
  /** Quote units credited to the spender wallet. Below `accountSpent` if anything was skimmed. */
  readonly spenderCredited: bigint;
  /** Quote units the swap actually consumed. */
  readonly swapInput: bigint;
  /** Asset units the account actually received. The fill, as the chain recorded it. */
  readonly filled: bigint;
  /** Quote units returned to the account by the refund leg. */
  readonly returned: bigint;
  /**
   * Quote units from this order still sitting in the spender wallet.
   *
   * Zero on a clean fill. NEGATIVE is an alarm, not a rounding artefact: it means more of
   * this token left the spender than this order ever put there, so the shortfall came out
   * of another order's balance. Reported signed rather than clamped, because clamping would
   * turn the one number that reveals cross-order contamination into a zero.
   */
  readonly residual: bigint;
  /** Realised price in quote units per whole asset unit, decimal string. Null with no fill. */
  readonly price: string | null;
  /** Total wei burned across every leg, INCLUDING reverted ones. Paid by the operator. */
  readonly gasWei: bigint;
  /** Per-leg wei, so an expensive leg is visible rather than averaged away. */
  readonly gasByLeg: Readonly<Partial<Record<Leg, bigint>>>;
  /** Net quote units the user is out of pocket: what left, minus what came back. */
  readonly netSpent: bigint;
};

function legReceipt(legs: readonly SettledLeg[], leg: Leg): ReceiptRecord | undefined {
  return legs.find((entry) => entry.leg === leg)?.receipt;
}

function successful(receipt: ReceiptRecord | undefined): ReceiptRecord | undefined {
  return receipt && receipt.status === "success" ? receipt : undefined;
}

/**
 * Quote units per whole asset unit, as an exact decimal string.
 *
 * Integer arithmetic throughout, and no `Decimal` — this package does not depend on
 * decimal.js and does not need to. Multiplying into the 10^18 scale BEFORE dividing keeps
 * every significant digit; the single truncating division at the end loses less than
 * 1e-18 of a dollar, which is fifteen orders of magnitude below a USDC unit.
 *
 * Three different scales meet here (asset 8, quote 6, price 18), so each one is applied by
 * name rather than positionally. The failure this guards against is not subtle when it
 * happens — a price off by 10^10 — but it is completely invisible in the code that causes it.
 */
export function realisedPrice(params: {
  readonly quoteAmount: bigint;
  readonly assetAmount: bigint;
  readonly assetDecimals: number;
  readonly quoteDecimals?: number | undefined;
}): string | null {
  const quoteDecimals = params.quoteDecimals ?? QUOTE_DECIMALS;
  if (params.quoteAmount <= 0n || params.assetAmount <= 0n) return null;
  if (!Number.isInteger(params.assetDecimals) || params.assetDecimals < 0) return null;
  const scaled =
    (params.quoteAmount * pow10(params.assetDecimals + PRICE_DECIMALS)) /
    (params.assetAmount * pow10(quoteDecimals));
  return whole(scaled, PRICE_DECIMALS);
}

/**
 * Reduce an order's settled legs to what actually happened.
 *
 * Amounts come from `Transfer` logs filtered by the addresses that matter, not from the
 * transaction's arguments. A swap's calldata says what was requested; its logs say what was
 * paid and delivered, and on a pool that moved between the quote and the fill those are
 * different numbers.
 */
export function realise(input: RealiseInput): RealisedOrder {
  const quoteDecimals = input.quoteDecimals ?? QUOTE_DECIMALS;
  const fund = successful(legReceipt(input.legs, "fund"));
  const swap = successful(legReceipt(input.legs, "swap"));
  const refund = successful(legReceipt(input.legs, "refund"));

  // On a buy the funding leg moves the quote token; on a sell it moves the asset. The
  // "input token" is whichever side the user is giving up, and reading the wrong one
  // silently reports zero rather than failing.
  const inputToken = input.side === "buy" ? input.quoteToken : input.assetToken;
  const outputToken = input.side === "buy" ? input.assetToken : input.quoteToken;

  const accountSpent = fund ? sent(fund.logs, inputToken, input.account) : 0n;
  const spenderCredited = fund ? received(fund.logs, inputToken, input.spender) : 0n;
  const swapInput = swap ? sent(swap.logs, inputToken, input.spender) : 0n;
  const filled = swap ? received(swap.logs, outputToken, input.account) : 0n;
  const returned = refund ? received(refund.logs, inputToken, input.account) : 0n;

  const gasByLeg: Partial<Record<Leg, bigint>> = {};
  let gasWei = 0n;
  for (const { leg, receipt } of input.legs) {
    const cost = transactionCost(receipt);
    gasByLeg[leg] = (gasByLeg[leg] ?? 0n) + cost;
    gasWei += cost;
  }

  const status: RealisedStatus = swap
    ? "filled"
    : refund
      ? "refunded"
      : fund
        ? "stranded"
        : input.legs.length > 0
          ? "not-funded"
          : "unsettled";

  // Price uses what the SWAP consumed, not what funding pulled. The two differ when the
  // router leaves dust behind, and the price the user got is the one the pool charged.
  const quoteAmount = input.side === "buy" ? swapInput : filled;
  const assetAmount = input.side === "buy" ? filled : swapInput;

  return {
    status,
    accountSpent,
    spenderCredited,
    swapInput,
    filled,
    returned,
    residual: spenderCredited - swapInput - returned,
    price: realisedPrice({
      quoteAmount,
      assetAmount,
      assetDecimals: input.assetDecimals,
      quoteDecimals,
    }),
    gasWei,
    gasByLeg,
    netSpent: accountSpent - returned,
  };
}

/**
 * Basis points of `delta` against `base`, rounded AWAY from zero.
 *
 * Rounding away from zero means a cost is never reported smaller than it was and a gain is
 * never reported larger; truncation toward zero would quietly turn a 0.9bp slippage into
 * 0bp, and a report full of zeroes is how a systematic leak stays invisible.
 */
function bps(delta: bigint, base: bigint): number | null {
  if (base <= 0n) return null;
  const scaled = delta * 10_000n;
  const quotient = scaled / base;
  const remainder = scaled % base;
  if (remainder === 0n) return Number(quotient);
  return Number(quotient + (delta < 0n ? -1n : 1n));
}

export type ExecutionQuality = {
  /** What the quote promised, in output units. */
  readonly quotedOut: bigint;
  /** The signed floor the swap carried. */
  readonly minOut: bigint;
  readonly actualOut: bigint;
  /** Positive means the fill was worse than quoted. Null when there was no quote to compare. */
  readonly slippageBps: number | null;
  /** How far above the floor the fill landed. Negative would mean the swap should have reverted. */
  readonly cushionBps: number | null;
  /**
   * True when the fill came in under the signed minimum.
   *
   * Should be unreachable: `amountOutMinimum` is enforced by the router, so a swap that
   * would breach it reverts. If this is ever true, either the floor was not the one that
   * was signed, or the output was measured against the wrong recipient — both of which are
   * far more serious than bad execution, so it is a distinct flag rather than a large
   * negative cushion.
   */
  readonly belowFloor: boolean;
  /** Realised price against the independent Chainlink reference, in bps. */
  readonly deviationFromReferenceBps: number | null;
};

/**
 * Compare a realised fill with what was promised and with the independent reference.
 *
 * Both comparisons are kept. Slippage against the quote measures the venue and the delay;
 * deviation from the Chainlink NAV measures whether the venue was priced sanely at all —
 * and that second one is what catches a fill that was "perfectly on quote" from a pool
 * quoting 118x off, which `packages/evm/src/venues/sanity.ts` exists because of.
 */
export function executionQuality(input: {
  readonly realised: RealisedOrder;
  readonly quotedOut: bigint;
  readonly minOut: bigint;
  /** Chainlink answer as a decimal string, same units as `RealisedOrder.price`. */
  readonly referencePrice?: string | undefined;
}): ExecutionQuality {
  const actualOut = input.realised.filled;
  let deviation: number | null = null;
  const price = input.realised.price;
  if (price !== null && input.referencePrice !== undefined)
    try {
      const reference = units(input.referencePrice, PRICE_DECIMALS);
      const realisedScaled = units(price, PRICE_DECIMALS);
      const delta =
        realisedScaled > reference ? realisedScaled - reference : reference - realisedScaled;
      deviation = bps(delta, reference);
    } catch {
      // An unparseable or non-positive reference is a missing observation, not a zero
      // deviation. Reporting 0 there would state that the fill matched a price we never had.
      deviation = null;
    }
  return {
    quotedOut: input.quotedOut,
    minOut: input.minOut,
    actualOut,
    slippageBps: bps(input.quotedOut - actualOut, input.quotedOut),
    cushionBps: bps(actualOut - input.minOut, input.minOut),
    belowFloor: input.minOut > 0n && actualOut > 0n && actualOut < input.minOut,
    deviationFromReferenceBps: deviation,
  };
}

export type Valuation = {
  /** Position value in quote units at the reference price. */
  readonly value: bigint;
  /** Value minus what the user paid. Unrealised: no sale has happened. */
  readonly unrealised: bigint;
  readonly referencePrice: string;
};

/**
 * Mark a filled position to the reference price.
 *
 * UNREALISED, and the name says so. It is the difference between what the position would be
 * worth at the reference and what the user paid for it; nothing has been sold, so nothing
 * has been realised, and presenting this as profit is the single most common way a trading
 * UI lies to someone.
 *
 * Two properties of the Chainlink B20 feeds change how this number should be read, and
 * neither is a bug to work around:
 *
 *  - They are TOTAL RETURN feeds. The split and dividend multiplier is already inside the
 *    answer. Applying the token's own oracle multiplier on top of it double-counts every
 *    corporate action the stock has ever had. Pass the feed answer through unmodified.
 *  - They have no heartbeat when the underlying equity market is shut, and hold the last
 *    close instead — measured at 15 hours stale on a weekday evening and around 64 hours
 *    across a weekend. A mark taken then is a mark at Friday's close, which is a correct
 *    valuation of a stale price and not a stale valuation. The token itself trades 24/7, so
 *    the number moves the instant the market reopens; treating that jump as P&L generated
 *    on Monday morning is a reporting error, not a trading one.
 */
export function markToMarket(input: {
  readonly shares: bigint;
  readonly assetDecimals: number;
  readonly referencePrice: string;
  /** Quote units the user actually paid, from `RealisedOrder.netSpent`. */
  readonly netSpent: bigint;
  readonly quoteDecimals?: number | undefined;
}): Valuation | null {
  const quoteDecimals = input.quoteDecimals ?? QUOTE_DECIMALS;
  if (input.shares < 0n) return null;
  let reference: bigint;
  try {
    reference = units(input.referencePrice, PRICE_DECIMALS);
  } catch {
    return null;
  }
  if (reference <= 0n) return null;
  // Multiply before dividing so a position smaller than one price tick is not floored away.
  const value =
    (input.shares * reference * pow10(quoteDecimals)) /
    (pow10(input.assetDecimals) * pow10(PRICE_DECIMALS));
  return { value, unrealised: value - input.netSpent, referencePrice: input.referencePrice };
}

/**
 * One line an operator or a user can read.
 *
 * Amounts are rendered through `whole` so they carry their real scale, and gas stays in wei
 * with the payer named — a sentence that says "cost 0.0004 ETH" without saying who paid it
 * is the ambiguity this whole module is trying to remove.
 */
export function describeRealised(order: RealisedOrder, assetDecimals: number): string {
  const quote = (raw: bigint) => whole(raw, QUOTE_DECIMALS);
  switch (order.status) {
    case "filled":
      return `Filled ${whole(order.filled, assetDecimals)} shares for ${quote(order.swapInput)} USDC at ${order.price ?? "an undetermined price"}; the spender paid ${order.gasWei} wei of gas.`;
    case "refunded":
      return `No trade: ${quote(order.accountSpent)} USDC was pulled and ${quote(order.returned)} returned; the spender paid ${order.gasWei} wei of gas and nothing is charged to the account.`;
    case "stranded":
      return `${quote(order.accountSpent)} USDC left the account and has neither been swapped nor returned; the spender is holding ${quote(order.residual)} USDC for this order.`;
    case "not-funded":
      return "Nothing left the account; the funding transaction did not settle.";
    default:
      return "No transaction for this order has settled.";
  }
}
