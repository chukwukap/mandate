import { Money } from "../evaluation/money.js";
import type { Asset, Caps, Envelope, OrderAction } from "../validation/schema.js";
import { positionKey, resolveAsset } from "./allowlist.js";
import { type Portfolio, type ResolvedSize, resolveSize } from "./sizing.js";

/**
 * Every reason an order can be turned away, as the exact string persisted to
 * `evaluations.refused`. Operators read these and packages/execution's tests compare
 * them verbatim, so they are named constants rather than inline literals.
 */
export const REFUSALS = {
  zero: "Order resolves to zero",
  orderCount: "Order count limit reached",
  cooldown: "Cooldown active",
  perOrder: "Per-order cap exceeded",
  perPeriod: "Period cap exceeded",
  lifetime: "Lifetime cap exceeded",
  position: "Insufficient stock balance",
  quote: "Insufficient USDC balance",
} as const;
export type Refusal = (typeof REFUSALS)[keyof typeof REFUSALS];

/** The persisted counters an envelope constrains. Owned by the runtime, advanced here. */
export type Counters = {
  lifetime: string;
  periodSpent: string;
  periodStart: number;
  orders: number;
  totalOrders: number;
};

/**
 * Advance `periodStart` to the boundary of the period containing `now`.
 *
 * The alignment matters. Resetting the origin to `now` would hand the strategy a
 * fresh full period every time the worker was late or restarted: a tick arriving
 * 3.5 periods after the last boundary must land exactly 3 periods forward and keep
 * the half period that has already elapsed, so a 24h cap stays a 24h cap. Returns
 * true when a new period was entered.
 *
 * Known divergence this package cannot fix: SpendPermissionManager anchors its own
 * period at the permission's `start`, chosen at prepare time, while this origin is
 * set when the instance is created. The two boundaries drift apart, so the server
 * can admit a spend the onchain allowance then refuses. apps/worker/src/chain.ts
 * catches that with getCurrentPeriod plus an allowance check and cancels the order
 * rather than losing funds, but it is a real source of cancelled orders.
 */
export function rollPeriod(counters: Counters, caps: Caps, now: number): boolean {
  const window = caps.period_secs * 1000;
  const elapsed = now - counters.periodStart;
  if (elapsed < window) return false;
  counters.periodStart += Math.floor(elapsed / window) * window;
  counters.periodSpent = "0";
  counters.orders = 0;
  return true;
}

export type Decision =
  | { readonly asset: Asset; readonly size: ResolvedSize }
  | { readonly refusal: Refusal };

/**
 * One tick's spend envelope: per-order, per-period, lifetime, cooldown, order count,
 * asset allowlist and available balance, in that order of cheapness.
 *
 * It holds the within-tick state the persisted counters cannot — the position
 * already committed by an earlier sell and the USDC already committed by an earlier
 * buy in the same evaluation. Without that, two sell actions in one firing would
 * each see the whole wallet balance, both be admitted, and only one could settle.
 *
 * Reservations are deliberately one-way. An admitted buy increments periodSpent and
 * lifetime immediately and a later cancel, revert or refund never releases it (see
 * docs/architecture/worker.md). Reported `spent` is therefore an over-estimate of
 * what settled — the direction that under-spends rather than over-spends a signed
 * cap, which is the only safe direction for an authority the user cannot re-approve.
 */
export class Budget {
  private readonly caps: Caps;
  private readonly positions: Record<string, string>;
  /** USDC the account can actually move, when the observer supplied it. */
  private quote: string | undefined;

  constructor(
    private readonly envelope: Envelope,
    private readonly counters: Counters,
    private readonly portfolio: Portfolio,
    private readonly now: number,
  ) {
    this.caps = envelope.caps;
    // Copied: refusing or admitting an order must not edit the caller's snapshot.
    this.positions = { ...portfolio.positions };
    this.quote = portfolio.quote;
  }

  /**
   * Decide one order and, when admitted, reserve what it consumes.
   *
   * `lastFire` is when this rule last fired, captured once before the firing's
   * actions run: several actions in a single firing share one cooldown, so the
   * second order of a pair is not blocked by the first (docs/architecture/worker.md).
   *
   * Throws only when the plan and the signed envelope disagree — an asset index
   * outside the allowlist. Validation rejects that before signing, so reaching it
   * means the stored plan and envelope no longer belong together, and refusing the
   * whole tick is safer than routing the order to whichever asset sits at that index.
   */
  admit(action: OrderAction, lastFire: number): Decision {
    const asset = resolveAsset(this.envelope, action.asset);
    const size = resolveSize(action.size, asset, action.side, this.portfolio);
    const refusal = this.refuse(action, asset, size, lastFire);
    if (refusal) return { refusal };
    this.reserve(action, asset, size);
    return { asset, size };
  }

  private refuse(
    action: OrderAction,
    asset: Asset,
    size: ResolvedSize,
    lastFire: number,
  ): Refusal | undefined {
    // Zero first: a percentage of an empty position floors to nothing, and a
    // zero-value swap burns gas for a no-op while consuming an order slot.
    if (size.raw === 0n) return REFUSALS.zero;
    if (this.counters.orders >= this.caps.max_orders_per_period) return REFUSALS.orderCount;
    if (this.now - lastFire < this.caps.cooldown_secs * 1000) return REFUSALS.cooldown;
    if (action.side === "sell") {
      const held = this.positions[positionKey(asset.token)] ?? "0";
      return new Money(size.amount).gt(held) ? REFUSALS.position : undefined;
    }
    const amount = new Money(size.amount);
    if (amount.gt(this.caps.per_order)) return REFUSALS.perOrder;
    if (new Money(this.counters.periodSpent).plus(amount).gt(this.caps.per_period))
      return REFUSALS.perPeriod;
    if (new Money(this.counters.lifetime).plus(amount).gt(this.caps.lifetime))
      return REFUSALS.lifetime;
    // Caps bound authority, not funds. A pct_equity buy sizes against USDC *plus*
    // oracle-valued stock, so a 100% buy can sit well inside every cap and still
    // exceed what the account can actually spend — discovered otherwise only as a
    // funding revert and a burnt fee. Checked only when the observer supplies a
    // spendable balance; a snapshot without one keeps today's behaviour.
    if (this.quote !== undefined && amount.gt(this.quote)) return REFUSALS.quote;
    return undefined;
  }

  private reserve(action: OrderAction, asset: Asset, size: ResolvedSize): void {
    if (action.side === "buy") {
      this.counters.periodSpent = new Money(this.counters.periodSpent).plus(size.amount).toFixed();
      this.counters.lifetime = new Money(this.counters.lifetime).plus(size.amount).toFixed();
      if (this.quote !== undefined) this.quote = new Money(this.quote).minus(size.amount).toFixed();
    } else {
      const key = positionKey(asset.token);
      this.positions[key] = new Money(this.positions[key] ?? "0").minus(size.amount).toFixed();
    }
    this.counters.orders++;
    this.counters.totalOrders++;
  }
}
