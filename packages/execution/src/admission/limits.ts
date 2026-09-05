import type { Caps, Runtime } from "@mandate/strategy";
import { units, whole } from "@mandate/strategy";
import { type Refusal, refuse } from "./refusal.js";

/** USDC. Every cap in an envelope is denominated in it, and it has six decimals. */
export const QUOTE_DECIMALS = 6;

/** The persisted counters an envelope constrains, as `instances.runtime` carries them. */
export type Counters = Pick<
  Runtime,
  "lifetime" | "periodSpent" | "periodStart" | "orders" | "totalOrders"
>;

export type Headroom = {
  /** Start of the period containing `now`, after rollover. Unix ms. */
  readonly periodStart: number;
  /** End of that period, exclusive. Unix ms. */
  readonly periodEnd: number;
  /** True when `now` fell outside the stored period and the window was advanced. */
  readonly rolled: boolean;
  readonly perOrder: bigint;
  readonly periodSpent: bigint;
  readonly perPeriod: bigint;
  readonly perPeriodRemaining: bigint;
  readonly lifetimeSpent: bigint;
  readonly lifetimeCap: bigint;
  readonly lifetimeRemaining: bigint;
  readonly orders: number;
  readonly maxOrders: number;
  readonly ordersRemaining: number;
  /** Milliseconds until this rule may fire again. 0 when it may fire now. */
  readonly cooldownRemainingMs: number;
  /** Strategy expiry, unix ms. */
  readonly expiresAt: number;
};

/**
 * Advance a period origin to the boundary of the period containing `now`.
 *
 * This is deliberately the same arithmetic `tick()` performs inline
 * (`packages/strategy/src/strategy.ts`), reproduced here because the two run at different
 * moments on the same counters. If this gate rolled the window differently — say by
 * resetting the origin to `now` — an order that `tick()` admitted inside a period could be
 * refused at funding time forever, and the order would livelock in `admitted` while the
 * strategy kept firing new ones. `test/admission-gate.test.ts` asserts the two agree at a
 * boundary rather than trusting this comment.
 *
 * Negative elapsed time (a clock that moved backwards, or a counter written by a host
 * ahead of this one) rolls nothing: `elapsed < window` is false only for a real forward
 * step, and resetting a window because of clock skew would hand out a free budget.
 */
export function rollPeriod(
  periodStart: number,
  periodSecs: number,
  now: number,
): { periodStart: number; rolled: boolean } {
  const window = periodSecs * 1000;
  const elapsed = now - periodStart;
  if (elapsed < window) return { periodStart, rolled: false };
  return {
    periodStart: periodStart + Math.floor(elapsed / window) * window,
    rolled: true,
  };
}

/**
 * What room is left under the signed envelope, in integer USDC minor units.
 *
 * Reported even when nothing is being refused, because "you have 3.500000 USDC of
 * per-period room left" is the number a user needs to understand why the next order will
 * not fit, and computing it only on failure means it is never available when asked.
 */
export function headroom(
  caps: Caps,
  counters: Counters,
  now: number,
  lastFireAt?: number | undefined,
): Headroom {
  const { periodStart, rolled } = rollPeriod(counters.periodStart, caps.period_secs, now);
  const perOrder = units(caps.per_order, QUOTE_DECIMALS);
  const perPeriod = units(caps.per_period, QUOTE_DECIMALS);
  const lifetimeCap = units(caps.lifetime, QUOTE_DECIMALS);
  // A rolled period releases both the spend and the order count, exactly as tick() does.
  const periodSpent = rolled ? 0n : units(counters.periodSpent, QUOTE_DECIMALS);
  const orders = rolled ? 0 : counters.orders;
  const lifetimeSpent = units(counters.lifetime, QUOTE_DECIMALS);
  const cooldownMs = caps.cooldown_secs * 1000;
  const sinceFire = lastFireAt === undefined ? Number.POSITIVE_INFINITY : now - lastFireAt;
  return {
    periodStart,
    periodEnd: periodStart + caps.period_secs * 1000,
    rolled,
    perOrder,
    periodSpent,
    perPeriod,
    // Clamped at zero: a cap lowered by a re-signed envelope can leave spend above it, and
    // a negative "remaining" reads as a credit in every UI that renders it.
    perPeriodRemaining: perPeriod > periodSpent ? perPeriod - periodSpent : 0n,
    lifetimeSpent,
    lifetimeCap,
    lifetimeRemaining: lifetimeCap > lifetimeSpent ? lifetimeCap - lifetimeSpent : 0n,
    orders,
    maxOrders: caps.max_orders_per_period,
    ordersRemaining: Math.max(0, caps.max_orders_per_period - orders),
    cooldownRemainingMs:
      sinceFire >= cooldownMs ? 0 : Math.max(0, Math.ceil(cooldownMs - sinceFire)),
    expiresAt: Date.parse(caps.expires_at),
  };
}

export type CapCheck = {
  readonly caps: Caps;
  readonly counters: Counters;
  /** Unix ms. */
  readonly now: number;
  /** Order input in the input token's minor units. Only a buy consumes USDC caps. */
  readonly amountIn: bigint;
  readonly side: "buy" | "sell";
  /** When this rule last fired, unix ms. Undefined means it has never fired. */
  readonly lastFireAt?: number | undefined;
  /**
   * True when `tick()` already counted this order against the persisted counters.
   *
   * This flag decides whether the same limit is a floor or a ceiling, and getting it
   * wrong breaks the system in one direction or the other:
   *
   * - `reserved: true` (the normal funding path). `periodSpent`, `lifetime`, `orders` and
   *   `lastFires` ALREADY include this order — they were advanced in the same transaction
   *   that created the `executions` row. Re-adding `amountIn` would double-count it, and
   *   re-checking the cooldown would refuse every order ever created, because the rule's
   *   last fire is this order's own admission a few seconds ago. So the reserved path
   *   checks only that the recorded totals still sit inside the signed caps, which catches
   *   the case that actually matters: a re-signed envelope with lower caps, or counters
   *   restored from a backup.
   * - `reserved: false` (a pre-admission or "would this fit?" query). The order has not
   *   been counted, so `amountIn` is added and the cooldown and order count apply.
   */
  readonly reserved: boolean;
};

/**
 * Re-check the signed spend envelope.
 *
 * Every refusal names the limit, the observed value and the bound, all in whole USDC so
 * the numbers match the review the user signed rather than the minor units the chain uses.
 * All applicable limits are evaluated — this does not stop at the first — because a user
 * who lowers their order size to clear the per-order cap should not then discover the
 * period cap on the next attempt.
 */
export function checkCaps(input: CapCheck): Refusal[] {
  const { caps, counters, now, amountIn, side, reserved } = input;
  const room = headroom(caps, counters, now, input.lastFireAt);
  const refusals: Refusal[] = [];
  const usdc = (raw: bigint) => whole(raw, QUOTE_DECIMALS);

  if (now >= room.expiresAt)
    refusals.push(
      refuse(
        "cap.expired",
        "The strategy's signed authority has expired",
        new Date(now).toISOString(),
        caps.expires_at,
        "UTC",
      ),
    );

  // Order count and cooldown are consumed at admission; see `reserved` above.
  if (!reserved) {
    if (room.orders >= room.maxOrders)
      refusals.push(
        refuse(
          "cap.orders_per_period",
          "No order slots left in this period",
          room.orders,
          room.maxOrders,
          "orders",
        ),
      );
    if (room.cooldownRemainingMs > 0)
      refusals.push(
        refuse(
          "cap.cooldown",
          "This rule is still in its cooldown",
          Math.ceil(room.cooldownRemainingMs / 1000),
          0,
          "seconds remaining",
        ),
      );
  } else if (room.orders > room.maxOrders)
    // Reserved orders may sit exactly at the limit; strictly above it means the recorded
    // count no longer fits the signed envelope.
    refusals.push(
      refuse(
        "cap.orders_per_period",
        "Recorded orders exceed the per-period order limit",
        room.orders,
        room.maxOrders,
        "orders",
      ),
    );

  // Sells consume no USDC authority. tick() bounds them by the held position, which is a
  // wallet fact rather than an envelope one and belongs to the observation path.
  if (side !== "buy") return refusals;

  if (amountIn > room.perOrder)
    refusals.push(
      refuse(
        "cap.per_order",
        "Order is larger than the per-order cap",
        usdc(amountIn),
        usdc(room.perOrder),
        "USDC",
      ),
    );

  const periodTotal = reserved ? room.periodSpent : room.periodSpent + amountIn;
  if (periodTotal > room.perPeriod)
    refusals.push(
      refuse(
        "cap.per_period",
        "Order does not fit the period spend cap",
        usdc(periodTotal),
        usdc(room.perPeriod),
        "USDC",
      ),
    );

  const lifetimeTotal = reserved ? room.lifetimeSpent : room.lifetimeSpent + amountIn;
  if (lifetimeTotal > room.lifetimeCap)
    refusals.push(
      refuse(
        "cap.lifetime",
        "Order does not fit the lifetime spend cap",
        usdc(lifetimeTotal),
        usdc(room.lifetimeCap),
        "USDC",
      ),
    );

  return refusals;
}
