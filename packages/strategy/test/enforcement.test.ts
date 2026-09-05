import { expect, test } from "bun:test";
import {
  Budget,
  type Counters,
  orderDecimals,
  type Portfolio,
  positionKey,
  REFUSALS,
  resolveAsset,
  resolveSize,
  rollPeriod,
} from "../src/enforcement/index.js";
import type { Asset, Envelope, OrderAction } from "../src/validation/index.js";
import { capsSchema } from "../src/validation/index.js";

const AAPL: Asset = {
  symbol: "AAPLc",
  // Checksummed on purpose: positions are keyed lowercase everywhere.
  token: "0xB200000000000000000000c2E324D24D7EEcd1Fb",
  feed: `0x${"22".repeat(20)}`,
  decimals: 8,
};
const KEY = AAPL.token.toLowerCase();
const T0 = Date.parse("2026-09-05T12:00:00Z");

function envelope(caps: Record<string, unknown> = {}): Envelope {
  return {
    version: "mandate/2",
    caps: capsSchema.parse({
      lifetime: "100",
      per_order: "10",
      per_period: "20",
      period_secs: 120,
      max_orders_per_period: 5,
      cooldown_secs: 60,
      expires_at: "2027-01-01T00:00:00Z",
      ...caps,
    }),
    assets: [AAPL],
    quote: `0x${"55".repeat(20)}`,
    venue: "aerodrome",
  };
}
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
const buy = (value: string): OrderAction => ({
  action: "order",
  asset: 0,
  side: "buy",
  size: { unit: "quote", value },
});
const sell = (value: string): OrderAction => ({
  action: "order",
  asset: 0,
  side: "sell",
  size: { unit: "base", value },
});
const held: Portfolio = { equity: "1000", positions: { [KEY]: "5" } };
/** Ready to fire: the rule has never fired, so no cooldown applies. */
const NEVER = Number.NEGATIVE_INFINITY;

function refusal(result: ReturnType<Budget["admit"]>): string | undefined {
  return "refusal" in result ? result.refusal : undefined;
}

test("periods roll to aligned boundaries, so a late tick does not win a fresh window", () => {
  const c = counters();
  const window = 120_000;
  expect(rollPeriod(c, envelope().caps, T0 + window - 1)).toBe(false);
  expect(c.periodStart).toBe(T0);

  // 3.5 periods late. Resetting the origin to `now` would hand the strategy a full
  // fresh period every time the worker restarted; alignment keeps the half period
  // that has already elapsed.
  c.periodSpent = "20";
  c.orders = 5;
  expect(rollPeriod(c, envelope().caps, T0 + 3.5 * window)).toBe(true);
  expect(c.periodStart).toBe(T0 + 3 * window);
  expect(c.periodSpent).toBe("0");
  expect(c.orders).toBe(0);
  // The remaining half period is not a new one.
  expect(rollPeriod(c, envelope().caps, T0 + 3.5 * window)).toBe(false);
});

test("each cap refuses independently, with the string operators read", () => {
  const cases: [Counters, OrderAction, number, string][] = [
    [counters(), buy("11"), NEVER, REFUSALS.perOrder],
    [counters({ periodSpent: "15" }), buy("10"), NEVER, REFUSALS.perPeriod],
    [counters({ lifetime: "95" }), buy("10"), NEVER, REFUSALS.lifetime],
    [counters({ orders: 5 }), buy("10"), NEVER, REFUSALS.orderCount],
    [counters(), buy("10"), T0 - 59_000, REFUSALS.cooldown],
    [counters(), sell("6"), NEVER, REFUSALS.position],
  ];
  for (const [c, action, lastFire, expected] of cases) {
    const before = structuredClone(c);
    expect(refusal(new Budget(envelope(), c, held, T0).admit(action, lastFire))).toBe(expected);
    // A refused order consumes nothing: no counter moves and no slot is used.
    expect(c).toEqual(before);
  }
  // One second past the cooldown the same order is admitted.
  expect(
    refusal(new Budget(envelope(), counters(), held, T0).admit(buy("10"), T0 - 60_000)),
  ).toBeUndefined();
});

test("an admitted buy reserves immediately and is never released", () => {
  const c = counters();
  const budget = new Budget(envelope(), c, held, T0);
  const decision = budget.admit(buy("10"), NEVER);
  expect("size" in decision && decision.size.amount).toBe("10");
  expect(c).toEqual(counters({ lifetime: "10", periodSpent: "10", orders: 1, totalOrders: 1 }));
  // Reservation happens at admission, before any transaction exists, and it
  // accumulates within the tick: the second order lands exactly on the 20 USDC
  // period cap and the third is refused by spend this tick has already committed.
  expect(refusal(budget.admit(buy("10"), NEVER))).toBeUndefined();
  expect(c.periodSpent).toBe("20");
  expect(refusal(budget.admit(buy("10"), NEVER))).toBe(REFUSALS.perPeriod);
  // A later cancel, revert or refund never releases those 20 USDC, so reported
  // spend over-estimates what settled — the direction that under-spends a signed cap.
  expect(c).toEqual(counters({ lifetime: "20", periodSpent: "20", orders: 2, totalOrders: 2 }));
});

test("two sells in one tick cannot reserve the same wallet balance", () => {
  const budget = new Budget(envelope(), counters(), held, T0);
  expect(refusal(budget.admit(sell("3"), NEVER))).toBeUndefined();
  // 5 held, 3 already committed by the first sell in this same evaluation. Reading
  // the untouched snapshot would admit both and only one could settle.
  expect(refusal(budget.admit(sell("3"), NEVER))).toBe(REFUSALS.position);
  expect(refusal(budget.admit(sell("2"), NEVER))).toBeUndefined();
});

test("percentages floor to the token's real decimals before any cap is checked", () => {
  const position = { equity: "1000", positions: { [KEY]: "1.23456789" } };
  const size = resolveSize({ unit: "pct_position", bps: 3333 }, AAPL, "sell", position);
  // 1.23456789 × 3333 / 10000 = 0.411481477737, which AAPLc's 8 decimals cannot
  // hold. Checking a cap against the unrounded number would authorise an amount
  // that differs from the integer actually sent onchain.
  expect(size.amount).toBe("0.41148147");
  expect(size.raw).toBe(41148147n);
  expect(size.decimals).toBe(8);

  // A buy spends USDC at 6 decimals whatever the stock's decimals are.
  expect(orderDecimals(AAPL, "buy")).toBe(6);
  expect(orderDecimals(AAPL, "sell")).toBe(8);
  expect(resolveSize({ unit: "pct_equity", bps: 1 }, AAPL, "buy", position).amount).toBe("0.1");

  // Dust floors to nothing; a zero-value swap burns gas and an order slot.
  const dust = new Budget(
    envelope(),
    counters(),
    { equity: "0", positions: { [KEY]: "0.000000005" } },
    T0,
  );
  expect(
    refusal(
      dust.admit(
        { action: "order", asset: 0, side: "sell", size: { unit: "pct_position", bps: 10_000 } },
        NEVER,
      ),
    ),
  ).toBe(REFUSALS.zero);
});

test("a percent-of-equity buy is refused against spendable USDC, not against wealth", () => {
  // equity is USDC plus oracle-valued stock. Sizing 100% of it against 5 USDC of
  // spendable balance is inside every cap and still cannot settle; without the
  // observer's `quote` the failure is a funding revert and a burnt fee.
  const wealthy: Portfolio = { equity: "1000", positions: { [KEY]: "5" }, quote: "5" };
  const budget = new Budget(
    envelope({ per_order: "20", per_period: "20" }),
    counters(),
    wealthy,
    T0,
  );
  expect(refusal(budget.admit(buy("10"), NEVER))).toBe(REFUSALS.quote);
  expect(refusal(budget.admit(buy("5"), NEVER))).toBeUndefined();
  // Spent USDC is committed within the tick too.
  expect(refusal(budget.admit(buy("1"), NEVER))).toBe(REFUSALS.quote);

  // A snapshot without `quote` keeps today's behaviour rather than refusing blindly.
  const legacy = new Budget(envelope({ per_order: "20", per_period: "20" }), counters(), held, T0);
  expect(refusal(legacy.admit(buy("10"), NEVER))).toBeUndefined();
});

test("several orders in one firing share that firing's cooldown", () => {
  // docs/architecture/worker.md: a rule that buys two assets must not half-block
  // itself. The caller captures lastFire once, before the actions run.
  const budget = new Budget(envelope(), counters(), held, T0);
  expect(refusal(budget.admit(buy("10"), NEVER))).toBeUndefined();
  expect(refusal(budget.admit(sell("1"), NEVER))).toBeUndefined();
});

test("positions resolve through one lowercase normaliser, whatever the catalogue casing", () => {
  expect(positionKey(AAPL.token)).toBe(KEY);
  expect(positionKey(KEY)).toBe(KEY);
  // A checksummed catalogue entry against a lowercase position map would otherwise
  // read every balance as zero and size every sell against nothing.
  expect(resolveSize({ unit: "pct_position", bps: 10_000 }, AAPL, "sell", held).amount).toBe("5");
});

test("an asset index outside the signed allowlist refuses the tick, it does not pick a neighbour", () => {
  expect(resolveAsset(envelope(), 0)).toEqual(AAPL);
  expect(() => resolveAsset(envelope(), 1)).toThrow("outside the signed allowlist");
  expect(() => resolveAsset(envelope(), -1)).toThrow("outside the signed allowlist");
  // The token is checked, not just the index: a rebuilt envelope must not be able
  // to route an order to an unusable address.
  const broken = { ...envelope(), assets: [{ ...AAPL, token: "0xnope" as Asset["token"] }] };
  expect(() => resolveAsset(broken, 0)).toThrow("no usable token address");
  const wrongDecimals = { ...envelope(), assets: [{ ...AAPL, decimals: 1.5 }] };
  expect(() => resolveAsset(wrongDecimals, 0)).toThrow("unusable decimals");
});
