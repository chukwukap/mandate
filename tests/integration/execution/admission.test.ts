import { expect, test } from "bun:test";
import { Problem } from "../../../packages/contracts/src/index.js";
import type { Counters } from "../../../packages/execution/src/admission/limits.js";
import {
  checkCaps,
  headroom,
  rollPeriod,
} from "../../../packages/execution/src/admission/limits.js";
import type { Refusal } from "../../../packages/execution/src/admission/refusal.js";
import {
  describeRefusal,
  describeRefusals,
  refusalProblem,
} from "../../../packages/execution/src/admission/refusal.js";
import { units, whole } from "../../../packages/strategy/src/evaluation/money.js";
import { assetOf, FakeChainClient, plainAsset } from "../../fixtures/chain/index.js";
import {
  caps,
  DAY_MS,
  isoAt,
  planOf,
  replay,
  STANDARD_ENVELOPE,
  strategyOf,
  T0,
} from "../../fixtures/strategies/index.js";

/**
 * The funding gate: everything that can turn away an order that already exists.
 *
 * These refusals are a different vocabulary from the tick-time ones in `@mandate/strategy`.
 * "Per-order cap exceeded" explains why an order was never created; the ids here explain why an
 * order the user can already see in their history will not be funded, and the two must not be
 * conflated because they end up in the same columns.
 *
 * Every assertion below is about a refusal NAMING what it hit. A gate that answers "refused" is
 * useless to the person holding the strategy: the number they have to change, and the number
 * they are being measured against, are the whole content of the answer.
 *
 * The order under test throughout is the one the fixtures describe — a 250 USDC buy of AAPLc —
 * and the permission fixtures are the library in `tests/fixtures/strategies`, each of which
 * breaks exactly one of the derivations the gate performs.
 */

const ORDER_USDC = units("250", 6);

/** Counters as `instances.runtime` carries them, before anything has been reserved. */
function counters(overrides: Partial<Counters> = {}): Counters {
  return {
    lifetime: "0",
    periodSpent: "0",
    periodStart: T0,
    orders: 0,
    totalOrders: 0,
    ...overrides,
  };
}

const limitsOf = (refusals: readonly Refusal[]) => refusals.map((refusal) => refusal.limit).sort();

test("a cap refusal names the limit, the size that was seen and the size that was allowed", () => {
  const refusals = checkCaps({
    caps: caps({ per_order: "10", per_period: "20", lifetime: "100" }),
    counters: counters(),
    now: T0,
    amountIn: ORDER_USDC,
    side: "buy",
    reserved: false,
  });

  const perOrder = refusals.find((refusal) => refusal.limit === "cap.per_order");
  expect(perOrder).toBeDefined();
  // Whole USDC on both sides, because those are the numbers in the review the user signed —
  // not the minor units the chain moves, which nobody signed anything about.
  expect(perOrder?.observed).toBe(whole(ORDER_USDC, 6));
  expect(perOrder?.bound).toBe("10");
  expect(perOrder?.unit).toBe("USDC");
  expect(describeRefusal(perOrder as Refusal)).toBe(
    "cap.per_order: Order is larger than the per-order cap (observed 250 USDC, limit 10 USDC)",
  );
});

test("every applicable cap is reported, so fixing one does not reveal the next", () => {
  const refusals = checkCaps({
    caps: caps({ per_order: "10", per_period: "20", lifetime: "100", max_orders_per_period: 1 }),
    counters: counters({ orders: 1, periodSpent: "15", lifetime: "95" }),
    now: T0,
    amountIn: ORDER_USDC,
    side: "buy",
    reserved: false,
  });

  expect(limitsOf(refusals)).toEqual([
    "cap.lifetime",
    "cap.orders_per_period",
    "cap.per_order",
    "cap.per_period",
  ]);
  // A user who lowers their size to clear the per-order cap should not then discover the
  // period cap on the next attempt, and the order count on the one after that.
  expect(refusals).toHaveLength(4);
});

test("a refused order is a 409 that names the first limit and lists the rest", () => {
  const refusals = checkCaps({
    caps: caps({ per_order: "10", per_period: "20", lifetime: "100" }),
    counters: counters(),
    now: T0,
    amountIn: ORDER_USDC,
    side: "buy",
    reserved: false,
  });
  const problem = refusalProblem(refusals);

  expect(problem).toBeInstanceOf(Problem);
  // 409, not 400 or 422: nothing about the request is malformed. It is the current state of the
  // caps that conflicts with running it, and that state can change without the caller changing
  // anything.
  expect(problem.status).toBe(409);
  expect(problem.code).toBe("refused:cap.per_order");
  for (const refusal of refusals) expect(problem.detail).toContain(refusal.limit);
  expect(problem.detail).toBe(describeRefusals(refusals));
});

test("the funding path does not re-charge an order that tick() already reserved", () => {
  // The counters `tick()` wrote for the fixture's single 250 USDC buy, and the moment it fired.
  const { runtime } = replay(strategyOf("conditional-buy"));
  const reserved = {
    caps: caps({ per_order: "250", per_period: "250", lifetime: "5000", cooldown_secs: 60 }),
    counters: runtime,
    now: T0,
    amountIn: ORDER_USDC,
    side: "buy" as const,
    lastFireAt: T0,
  };

  // `periodSpent` already includes this order and the rule's last firing IS this order's own
  // admission, seconds ago. Adding the amount again would refuse every order the strategy ever
  // produced, and re-checking the cooldown would refuse all of them for a different reason.
  expect(checkCaps({ ...reserved, reserved: true })).toEqual([]);
  expect(limitsOf(checkCaps({ ...reserved, reserved: false }))).toEqual([
    "cap.cooldown",
    "cap.per_period",
  ]);
  expect(runtime.periodSpent).toBe("250");
  expect(runtime.orders).toBe(1);
});

test("a re-signed envelope with lower caps stops funding an order admitted under the old one", () => {
  const { runtime } = replay(strategyOf("conditional-buy"));
  // The user re-signed at a 100 USDC per-order cap after the order was created. The reserved
  // path exists to catch exactly this, and the restored-from-backup counters that look like it.
  const refusals = checkCaps({
    caps: caps({ per_order: "100", per_period: "100", lifetime: "5000" }),
    counters: runtime,
    now: T0,
    amountIn: ORDER_USDC,
    side: "buy",
    reserved: true,
  });

  expect(limitsOf(refusals)).toEqual(["cap.per_order", "cap.per_period"]);
  expect(refusals.find((refusal) => refusal.limit === "cap.per_period")?.observed).toBe("250");
  expect(refusals.find((refusal) => refusal.limit === "cap.per_period")?.bound).toBe("100");
});

test("a sell consumes no USDC authority and is not measured against the spend caps", () => {
  const refusals = checkCaps({
    caps: caps({ per_order: "10", per_period: "20", lifetime: "100" }),
    counters: counters(),
    now: T0,
    // A sell's input is shares, not dollars. Measuring it against a USDC cap would compare an
    // 8-decimal share amount to a 6-decimal dollar one and refuse every sell ever placed.
    amountIn: units("1", 8),
    side: "sell",
    reserved: false,
  });
  expect(refusals).toEqual([]);
});

test("the period window rolls on aligned boundaries rather than resetting to now", () => {
  const period = 86_400;
  // Mid-period: nothing rolls, and the spend stays spent.
  expect(rollPeriod(T0, period, T0 + DAY_MS / 2)).toEqual({ periodStart: T0, rolled: false });
  // Two and a half periods on: the origin advances by whole windows. Resetting it to `now`
  // would hand out a fresh budget on every tick that happened to land late.
  expect(rollPeriod(T0, period, T0 + 2.5 * DAY_MS)).toEqual({
    periodStart: T0 + 2 * DAY_MS,
    rolled: true,
  });
  // A clock that went backwards — skew, or a counter written by a host ahead of this one —
  // rolls nothing. Rolling on negative elapsed time is a free budget.
  expect(rollPeriod(T0, period, T0 - 1000)).toEqual({ periodStart: T0, rolled: false });

  const room = headroom(
    caps({ per_period: "1000", lifetime: "5000", max_orders_per_period: 10 }),
    counters({ periodSpent: "900", orders: 9, lifetime: "900" }),
    T0 + DAY_MS,
  );
  expect(room.rolled).toBe(true);
  // The rolled window releases the period spend and the order count, exactly as tick() does,
  // and leaves the lifetime total alone — that one never rolls.
  expect(room.periodSpent).toBe(0n);
  expect(room.ordersRemaining).toBe(10);
  expect(room.lifetimeSpent).toBe(units("900", 6));
  expect(room.periodStart).toBe(T0 + DAY_MS);
});

test("headroom reports the room left even when nothing is being refused", () => {
  const room = headroom(
    caps({ per_order: "250", per_period: "1000", lifetime: "5000" }),
    counters({ periodSpent: "250", lifetime: "250", orders: 1 }),
    T0,
  );
  // "You have 750 USDC of period room left" is the number a user needs to understand why the
  // next order will not fit; computing it only on failure means it is never there when asked.
  expect(whole(room.perPeriodRemaining, 6)).toBe("750");
  expect(whole(room.lifetimeRemaining, 6)).toBe("4750");
  expect(room.cooldownRemainingMs).toBe(0);
});

test("an expired mandate refuses at funding and says which deadline it passed", () => {
  const expired = caps({ expires_at: isoAt(T0 - 3_600_000) });
  const refusals = checkCaps({
    caps: expired,
    counters: counters(),
    now: T0,
    amountIn: ORDER_USDC,
    side: "buy",
    reserved: true,
  });
  const refusal = refusals.find((entry) => entry.limit === "cap.expired");
  expect(refusal?.observed).toBe(new Date(T0).toISOString());
  expect(refusal?.bound).toBe(expired.expires_at);
  expect(refusal?.unit).toBe("UTC");
});

test("no refusal is ever produced without an observed value, a bound and a unit", () => {
  const produced: Refusal[] = [
    ...checkCaps({
      caps: caps({ per_order: "10", per_period: "20", lifetime: "100", max_orders_per_period: 1 }),
      counters: counters({ orders: 3 }),
      now: T0 + 40 * DAY_MS,
      amountIn: ORDER_USDC,
      side: "buy",
      reserved: false,
    }),
  ];
  expect(produced.length).toBeGreaterThan(0);

  for (const refusal of produced) {
    // A refusal that names a limit without saying what was seen and what was allowed is the
    // failure this whole vocabulary exists to prevent.
    expect(refusal.observed.length).toBeGreaterThan(0);
    expect(refusal.bound.length).toBeGreaterThan(0);
    expect(refusal.unit.length).toBeGreaterThan(0);
    expect(refusal.title.length).toBeGreaterThan(0);
  }

  // And none of them carries the signature the permission was granted with. These strings are
  // persisted to `executions.reason` and returned to users; pino's redaction works on field
  // names and would not touch a value interpolated into a sentence.
  const sentence = describeRefusals(produced);
  expect(sentence).not.toContain("cd".repeat(20));
  // Bounded, because an unbounded string built from unbounded input is how a log line becomes
  // a payload.
  expect(sentence.length).toBeLessThanOrEqual(900);
});

test("an unfillable pair is refused by the venue, in a different vocabulary from the caps", async () => {
  const chain = new FakeChainClient();
  const slippage = STANDARD_ENVELOPE.caps.slippage_bps;

  // MSFTc is a real, deployed B20 equity with a live Chainlink reference and no Aerodrome pool
  // this system routes. The caps are fine, the permission is fine, and the order still cannot
  // run — so it dies at the quote, which is where liquidity that vanished after signing has to
  // be discovered.
  const untradable = chain.quote(plainAsset(assetOf("MSFTc")), "buy", "250", slippage);
  await expect(untradable).rejects.toThrow(Problem);
  await untradable.catch((error: unknown) => {
    expect(error).toBeInstanceOf(Problem);
    const problem = error as Problem;
    // 503, not the 409 a cap refusal produces: the user has nothing to change. A "no liquidity"
    // failure and a "no reference price" failure are also different, and this one is the first.
    expect(problem.status).toBe(503);
    expect(problem.detail).toMatch(/liquidity/);
  });

  // The same size on the same envelope's tradable asset routes, and it routes through the
  // healthy pool rather than the tick-spacing-200 one that quotes 118x off the reference.
  const quote = await chain.quote(plainAsset(assetOf("AAPLc")), "buy", "250", slippage);
  expect(quote.tick_spacing).toBe(10);
  expect(BigInt(quote.min_out)).toBeLessThan(BigInt(quote.amount_out));
  expect(quote.reference).toBe("320.08");
});

test("an admitted direct-wallet order does not reserve its caps twice", () => {
  const fixture = strategyOf("conditional-buy");
  const { results, runtime } = replay(fixture);
  const intent = results[0]?.intents[0];
  if (!intent) throw new Error("conditional-buy must admit one order");
  expect(planOf(fixture).machines).toHaveLength(1);

  const amountIn = units(intent.amount, 6);
  expect(amountIn).toBe(ORDER_USDC);
  expect(
    checkCaps({
      caps: fixture.envelope.caps,
      counters: runtime,
      now: T0,
      amountIn,
      side: intent.side,
      reserved: true,
    }),
  ).toEqual([]);
});
