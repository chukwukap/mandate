import { expect, test } from "bun:test";
import { Problem } from "../../../packages/contracts/src/index.js";
import { checkPermission } from "../../../packages/execution/src/admission/permission.js";
import type { LimitId } from "../../../packages/execution/src/admission/refusal.js";
import { units } from "../../../packages/strategy/src/evaluation/money.js";
import { tick } from "../../../packages/strategy/src/machines/index.js";
import { PlanInvalid } from "../../../packages/strategy/src/validation/issues.js";
import { ACCOUNTS, FakeChainClient } from "../chain/index.js";
import {
  evidenceOf,
  PERMISSIONS,
  permissionOf,
  planOf,
  replay,
  SIGNED_ALLOWANCE,
  STANDARD_ENVELOPE,
  STRATEGIES,
  strategyOf,
  T0,
} from "./index.js";

const ORDER_USDC = 250_000_000n;

function refusalsFor(id: string, overrides: { amountIn?: bigint } = {}) {
  return checkPermission({
    evidence: evidenceOf(permissionOf(id)),
    account: ACCOUNTS.user,
    spender: ACCOUNTS.spender,
    caps: STANDARD_ENVELOPE.caps,
    amountIn: overrides.amountIn ?? ORDER_USDC,
    now: T0,
  }).map((refusal) => refusal.limit);
}

test("every runnable fixture validates against its own signed allowlist", () => {
  for (const fixture of STRATEGIES) {
    if (fixture.expected.kind !== "ticks") continue;
    const plan = planOf(fixture);
    expect(plan.machines.length).toBeGreaterThan(0);
    // A fixture whose plan and envelope disagree about the asset list would size orders
    // against whichever token happened to sit at that index.
    expect(fixture.envelope.assets).toEqual([...fixture.assets]);
  }
});

test("every fixture's declared outcome is the one the real tick produces", () => {
  for (const fixture of STRATEGIES) {
    if (fixture.expected.kind !== "ticks") continue;
    const { results, runtime } = replay(fixture);
    expect(results.map((result) => result.intents.length)).toEqual([...fixture.expected.intents]);
    expect(results.map((result) => result.refused)).toEqual(
      fixture.expected.refused.map((refusals) => [...refusals]),
    );
    expect(runtime.halted).toBe(fixture.expected.halted);
    // A fixture that names its funding outcome must still be right about it a release later.
    if (fixture.expected.permissionRefusals && fixture.permission)
      expect(refusalsFor(fixture.permission.id).sort()).toEqual(
        [...fixture.expected.permissionRefusals].sort(),
      );
  }
});

test("the simple conditional buy produces one fully specified order", () => {
  const fixture = strategyOf("conditional-buy");
  const { results, runtime } = replay(fixture);
  const intent = results[0]?.intents[0];
  expect(intent).toEqual({
    asset: 0,
    side: "buy",
    // Floored to USDC's six decimals before anything checks it against a cap.
    amount: "250",
    fireKey: "entry_machine/waiting/0",
  });
  // The machine parked in `holding`, and the counters moved by exactly one order.
  expect(runtime.machines.entry_machine?.current).toBe("holding");
  expect(runtime.periodSpent).toBe("250");
  expect(runtime.lifetime).toBe("250");
  expect(runtime.orders).toBe(1);
  expect(runtime.totalOrders).toBe(1);
});

test("the second order of a firing sees the first one's reservation", () => {
  const { results, runtime } = replay(strategyOf("envelope-tripped"));
  expect(results[0]?.intents).toHaveLength(1);
  // 250 admitted, 250 refused: 250 + 250 is over the 300 USDC period cap, and only a budget
  // that reserved within the tick can know that.
  expect(runtime.periodSpent).toBe("250");
  expect(runtime.orders).toBe(1);
  expect(results[0]?.refused).toEqual(["Period cap exceeded"]);
});

test("an edge-triggered rule fires once per crossing; the level-triggered one repeats", () => {
  const edge = replay(strategyOf("edge-triggered-once"));
  const level = replay(strategyOf("level-triggered-repeats"));
  const total = (run: { results: readonly { intents: unknown[] }[] }) =>
    run.results.reduce((sum, result) => sum + result.intents.length, 0);
  // Five ticks, four of them with the guard true. Edge-triggered buys twice — once per
  // false->true crossing — where level-triggered buys four times against the same prices.
  expect(total(edge)).toBe(2);
  expect(total(level)).toBe(4);
  expect(edge.runtime.periodSpent).toBe("100");
  expect(level.runtime.periodSpent).toBe("200");
  // The repeat counter resets when the guard goes false, so the cap bounds one episode.
  expect(level.runtime.machines.entry_machine?.repeats["watching/0"]).toBe(2);
});

test("a halted instance stops evaluating and never rewrites its halt reason", () => {
  const fixture = strategyOf("expired-mandate");
  const { runtime, results } = replay(fixture);
  expect(runtime.halted).toBe(true);
  expect(results[0]?.refused).toEqual(["Strategy expired"]);
  const input = fixture.ticks[0];
  if (!input) throw new Error("expired-mandate needs a tick");
  // Tick the halted runtime itself, a minute later. A halt is terminal and precedes even the
  // expiry check, so the instance cannot accumulate a second refusal or rewrite its reason —
  // a history that repeated "Strategy expired" once a minute forever would bury everything
  // that actually happened to the strategy.
  const again = tick(
    planOf(fixture),
    fixture.envelope,
    runtime,
    input.feeds,
    input.portfolio,
    input.at + 60_000,
  );
  expect(again.refused).toEqual([]);
  expect(again.intents).toEqual([]);
  expect(again.state).toEqual(runtime);
});

test("an expired grant refuses at funding while the strategy layer sees nothing wrong", async () => {
  const fixture = strategyOf("expired-permission");
  const { results } = replay(fixture);
  // The plan, the caps and the market are all fine — one order is admitted.
  expect(results[0]?.intents).toHaveLength(1);
  const expected = fixture.expected;
  if (expected.kind !== "ticks" || !expected.permissionRefusals)
    throw new Error("expired-permission must declare its funding refusals");
  expect(refusalsFor("expired").sort()).toEqual([...expected.permissionRefusals].sort());
  // ...and the same order under a live grant is refused by nothing.
  expect(refusalsFor("active")).toEqual([]);
});

test("each permission fixture breaks exactly the derivation it claims to", () => {
  const cases: Record<string, LimitId[]> = {
    active: [],
    expired: ["permission.inactive", "permission.expired"],
    // Approval and revocation are separate flags: `isApproved` still answers true here, so a
    // gate that only read approval would keep spending after the user revoked.
    revoked: ["permission.inactive", "permission.inactive"],
    "not-started": ["permission.not_started"],
    "ending-inside-horizon": ["permission.horizon"],
    "allowance-mismatch": ["permission.allowance_mismatch"],
    "wrong-spender": ["permission.spender_mismatch"],
    "hash-mismatch": ["permission.hash_mismatch"],
    "period-exhausted": ["permission.period_allowance"],
  };
  expect(Object.keys(cases).sort()).toEqual(PERMISSIONS.map((p) => p.id).sort());
  for (const [id, limits] of Object.entries(cases))
    expect({ id, limits: refusalsFor(id).sort() }).toEqual({ id, limits: [...limits].sort() });
  // The signed allowance is the per-period cap in USDC minor units, not a round number
  // somebody typed: a mismatch here is the review saying one thing and the chain another.
  expect(SIGNED_ALLOWANCE).toBe(units(STANDARD_ENVELOPE.caps.per_period, 6).toString());
});

test("a missing permission is refused without an exception", () => {
  const refusals = checkPermission({
    evidence: undefined,
    account: ACCOUNTS.user,
    spender: ACCOUNTS.spender,
    caps: STANDARD_ENVELOPE.caps,
    amountIn: ORDER_USDC,
    now: T0,
  });
  // A wrong or absent row must stop an order, not crash the tick that would record why.
  expect(refusals.map((refusal) => refusal.limit)).toEqual(["permission.missing"]);
});

test("an untradable asset is admitted by the strategy and refused by the venue", async () => {
  const fixture = strategyOf("untradable-asset");
  const { results } = replay(fixture);
  const intent = results[0]?.intents[0];
  expect(intent?.asset).toBe(1);
  const asset = fixture.envelope.assets[intent?.asset ?? 0];
  if (!asset || !intent) throw new Error("untradable-asset must admit one order");
  expect(asset.symbol).toBe("MSFTc");
  const expected = fixture.expected;
  if (expected.kind !== "ticks" || !expected.venue) throw new Error("missing venue expectation");
  try {
    await new FakeChainClient().quote(
      asset,
      "buy",
      intent.amount,
      fixture.envelope.caps.slippage_bps,
    );
    throw new Error("expected the venue to refuse");
  } catch (error) {
    expect(error).toBeInstanceOf(Problem);
    expect((error as Problem).status).toBe(expected.venue.status);
    expect((error as Error).message).toMatch(expected.venue.detail);
  }
  // The reference price is fine. "We cannot fill this" and "we cannot price this" are
  // different failures, and telling a user the second one sends them to the wrong place.
  const feeds = await new FakeChainClient().market();
  expect(feeds.find((entry) => entry.uri === "oracle:MSFTc")?.stale).toBe(false);
});

test("a malformed plan reports every problem at once, addressed at the rule that caused it", () => {
  for (const fixture of STRATEGIES) {
    if (fixture.expected.kind !== "plan-invalid") continue;
    let caught: unknown;
    try {
      planOf(fixture);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanInvalid);
    const invalid = caught as PlanInvalid;
    // 400, not 500: the plan is the user's input and every issue is theirs to fix.
    expect(invalid.status).toBe(400);
    expect(invalid.code).toBe("invalid-plan");
    expect([...new Set(invalid.issues.map((issue) => issue.code))].sort()).toEqual([
      ...fixture.expected.codes,
    ]);
    for (const path of fixture.expected.paths)
      expect(invalid.issues.some((issue) => issue.path === path)).toBe(true);
    // The detail is what a user reads. It must name the path and say something actionable
    // about it, not flatten the first failure into a generic sentence.
    for (const issue of invalid.issues) expect(invalid.detail).toContain(`${issue.path}: `);
    expect(invalid.detail.length).toBeGreaterThan(80);
  }
});

test("the semantic failures are described in words a user can act on", () => {
  try {
    planOf(strategyOf("malformed-semantics"));
    throw new Error("expected the plan to be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(PlanInvalid);
    const messages = (error as PlanInvalid).issues.map((issue) => issue.message);
    expect(messages.join(" | ")).toContain("gt takes exactly 2 arguments");
    expect(messages.join(" | ")).toContain("Available feeds:");
    expect(messages.some((message) => message.includes("outside the signed allowlist"))).toBe(true);
    expect(messages.some((message) => message.includes("sized in base or pct_position"))).toBe(
      true,
    );
    expect(messages.some((message) => message.includes("cannot be reached"))).toBe(true);
  }
});
