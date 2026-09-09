import { expect, test } from "bun:test";
import type { Portfolio, Runtime } from "../src/machines/index.js";
import { initialRuntime, runtimeSchema, tick } from "../src/machines/index.js";
import { canonical } from "../src/review/canonical.js";
import type { Asset, Envelope, Plan } from "../src/validation/index.js";
import { capsSchema, validatePlan } from "../src/validation/index.js";

const AAPL: Asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}`,
  feed: `0x${"22".repeat(20)}`,
  decimals: 8,
};
const T0 = Date.parse("2026-09-05T12:00:00Z");
const portfolio: Portfolio = {
  equity: "1000",
  positions: { [AAPL.token.toLowerCase()]: "5" },
};

/** oracle:AAPLc below 200, and dex:AAPLc below 200 — two independently drivable guards. */
const nodes = [
  {
    id: "cheap",
    op: "lt",
    args: [
      { kind: "feed", feed: "oracle:AAPLc" },
      { kind: "const", value: "200" },
    ],
  },
  {
    id: "pool_cheap",
    op: "lt",
    args: [
      { kind: "feed", feed: "dex:AAPLc" },
      { kind: "const", value: "200" },
    ],
  },
];
const buy = { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } };

function build(transitions: unknown[]): { plan: Plan; envelope: Envelope } {
  const plan = validatePlan(
    {
      nodes,
      machines: [{ id: "m", scope: "portfolio", initial: "s", states: [{ id: "s", transitions }] }],
    },
    [AAPL],
  );
  return {
    plan,
    envelope: {
      version: "mandate/2",
      caps: capsSchema.parse({
        lifetime: "1000",
        per_order: "10",
        per_period: "1000",
        period_secs: 86400,
        max_orders_per_period: 1000,
        cooldown_secs: 0,
        expires_at: "2027-01-01T00:00:00Z",
      }),
      assets: [AAPL],
      quote: `0x${"55".repeat(20)}`,
      venue: "aerodrome",
    },
  };
}
const feeds = (oracle: string, dex = "999") => ({ "oracle:AAPLc": oracle, "dex:AAPLc": dex });

test("a guard that stays true fires once, not once per tick", () => {
  const { plan, envelope } = build([{ when: "cheap", to: "s", actions: [buy] }]);
  let state = initialRuntime(plan, T0);
  const fired: number[] = [];
  // Ten consecutive ticks with the price still below the threshold. Level-triggered
  // evaluation would spend the whole period cap here in ten minutes.
  for (let i = 0; i < 10; i++) {
    const result = tick(plan, envelope, state, feeds("150"), portfolio, T0 + i * 60_000);
    fired.push(result.intents.length);
    state = result.state;
  }
  expect(fired).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(state.lifetime).toBe("10");
  expect(state.totalOrders).toBe(1);
});

test("an on_edge rule fires again only after its guard has gone false and back", () => {
  const { plan, envelope } = build([{ when: "cheap", to: "s", actions: [buy] }]);
  let state = initialRuntime(plan, T0);
  const prices = ["150", "150", "300", "300", "150"];
  const fired = prices.map((price, i) => {
    const result = tick(plan, envelope, state, feeds(price), portfolio, T0 + i * 60_000);
    state = result.state;
    return result.intents.length;
  });
  expect(fired).toEqual([1, 0, 0, 0, 1]);
  expect(state.totalOrders).toBe(2);
});

test("while_true stops at max_repeats, and the counter resets when the guard goes false", () => {
  const { plan, envelope } = build([
    { when: "cheap", fires: "while_true", max_repeats: 3, to: "s", actions: [buy] },
  ]);
  let state = initialRuntime(plan, T0);
  const prices = ["150", "150", "150", "150", "150", "300", "150", "150"];
  const fired = prices.map((price, i) => {
    const result = tick(plan, envelope, state, feeds(price), portfolio, T0 + i * 60_000);
    state = result.state;
    return result.intents.length;
  });
  // Three firings, then silence while the guard stays true; the false tick resets
  // the counter so the next episode gets its own three, not a shared lifetime total.
  expect(fired).toEqual([1, 1, 1, 0, 0, 0, 1, 1]);
});

test("only the first eligible rule fires, but every rule's edge is still recorded", () => {
  const { plan, envelope } = build([
    { when: "cheap", to: "s", actions: [{ action: "notify", message: "first" }] },
    { when: "pool_cheap", to: "s", actions: [{ action: "notify", message: "second" }] },
  ]);
  let state = initialRuntime(plan, T0);

  const both = tick(plan, envelope, state, feeds("150", "150"), portfolio, T0);
  // Firing moves the machine on, so later rules belong to the state it just left.
  expect(both.notifications).toEqual(["first"]);
  state = both.state;
  expect(state.machines.m?.edges).toEqual({ "s/0": true, "s/1": true });

  // The second rule's guard has been true since the previous tick, so there is no
  // rising edge for it now. If its edge had not been recorded while it lost, it
  // would fire here from a crossing that never happened.
  const next = tick(plan, envelope, state, feeds("300", "150"), portfolio, T0 + 60_000);
  expect(next.notifications).toEqual([]);
  state = next.state;

  // Drive the second guard false and back: now it genuinely crosses, and fires.
  state = tick(plan, envelope, state, feeds("300", "300"), portfolio, T0 + 120_000).state;
  const crossed = tick(plan, envelope, state, feeds("300", "150"), portfolio, T0 + 180_000);
  expect(crossed.notifications).toEqual(["second"]);
});

test("a halt suppresses intents admitted earlier in the same tick", () => {
  const { plan, envelope } = build([
    {
      when: "cheap",
      to: "s",
      actions: [buy, { action: "halt", reason: "Circuit breaker" }, buy],
    },
  ]);
  const result = tick(plan, envelope, initialRuntime(plan, T0), feeds("150"), portfolio, T0);
  expect(result.state.halted).toBe(true);
  expect(result.intents).toEqual([]);
  expect(result.notifications).toEqual(["Circuit breaker"]);
  // The first buy's budget stays reserved. Reservations are one-way, so a halting
  // tick consumes cap for an order that is never sent: it under-spends the signed
  // authority, which is the only safe direction.
  expect(result.state.lifetime).toBe("10");

  // A halt is terminal: the next tick does nothing at all, whatever the price.
  const after = tick(plan, envelope, result.state, feeds("150"), portfolio, T0 + 60_000);
  expect(after.intents).toEqual([]);
  expect(after.notifications).toEqual([]);
  expect(after.state.lifetime).toBe("10");
});

test("tick never mutates the runtime, portfolio or feeds it was given", () => {
  const { plan, envelope } = build([
    {
      when: "cheap",
      to: "s",
      actions: [
        buy,
        { action: "order", asset: 0, side: "sell", size: { unit: "base", value: "1" } },
      ],
    },
  ]);
  const before = initialRuntime(plan, T0);
  const snapshot = canonical(before);
  const positions = { ...portfolio.positions };
  const result = tick(plan, envelope, before, feeds("150"), portfolio, T0);
  expect(result.intents).toHaveLength(2);
  // The caller must be able to retry the same tick against the same snapshot.
  expect(canonical(before)).toBe(snapshot);
  expect(portfolio.positions).toEqual(positions);
  expect(result.state).not.toBe(before);
});

test("expiry halts before anything is evaluated, and needs no observations", () => {
  const { plan, envelope } = build([{ when: "cheap", to: "s", actions: [buy] }]);
  const expired = Date.parse(envelope.caps.expires_at);
  // Feeds are deliberately empty: past expiry the user's authorization is dead, so
  // there is nothing an observation could justify.
  const result = tick(plan, envelope, initialRuntime(plan, T0), {}, portfolio, expired);
  expect(result.state.halted).toBe(true);
  expect(result.refused).toEqual(["Strategy expired"]);
  expect(result.intents).toEqual([]);
});

test("a missing observation skips the whole tick rather than half of it", () => {
  const { plan, envelope } = build([{ when: "cheap", to: "s", actions: [buy] }]);
  const state = initialRuntime(plan, T0);
  expect(() => tick(plan, envelope, state, { "dex:AAPLc": "150" }, portfolio, T0)).toThrow(
    "missing observation oracle:AAPLc",
  );
  // Nothing was recorded: no partial edge memory that would suppress the real
  // rising edge once the feed comes back.
  expect(state.machines.m?.edges).toEqual({});
});

test("a corrupted spend counter fails the tick instead of silently unbinding the cap", () => {
  const { plan, envelope } = build([{ when: "cheap", to: "s", actions: [buy] }]);
  const corrupted: Runtime = { ...initialRuntime(plan, T0), lifetime: "unknown" };
  // new Money("unknown") throws, but new Money("NaN") would not: NaN.gt(cap) is
  // false, and the lifetime cap would stop binding on a bad JSONB row.
  expect(() => tick(plan, envelope, corrupted, feeds("150"), portfolio, T0)).toThrow(
    "not decimal numbers",
  );
  expect(() =>
    tick(plan, envelope, { ...corrupted, lifetime: "NaN" }, feeds("150"), portfolio, T0),
  ).toThrow("not decimal numbers");
});

test("a runtime that does not match the signed plan fails loudly", () => {
  const { plan, envelope } = build([{ when: "cheap", to: "s", actions: [buy] }]);
  const state = initialRuntime(plan, T0);
  expect(() =>
    tick(plan, envelope, { ...state, machines: {} }, feeds("150"), portfolio, T0),
  ).toThrow("Missing persisted machine: m");
  expect(() =>
    tick(
      plan,
      envelope,
      { ...state, machines: { m: { current: "gone", vars: {}, edges: {}, repeats: {} } } },
      feeds("150"),
      portfolio,
      T0,
    ),
  ).toThrow("Invalid persisted state: gone");
});

test("a persisted runtime round-trips through its schema", () => {
  const { plan, envelope } = build([{ when: "cheap", to: "s", actions: [buy] }]);
  const after = tick(plan, envelope, initialRuntime(plan, T0), feeds("150"), portfolio, T0).state;
  // JSONB gives back plain values; parsing is what stops an older or hand-edited
  // row from being ticked on.
  expect(runtimeSchema.parse(JSON.parse(JSON.stringify(after)))).toEqual(after);
  expect(() => runtimeSchema.parse({ ...after, lifetime: 10 })).toThrow();
  expect(() => runtimeSchema.parse({ ...after, halted: undefined })).toThrow();
});
