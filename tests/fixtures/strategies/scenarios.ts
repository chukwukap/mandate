import type { Asset as WireAsset } from "../../../packages/contracts/src/index.js";
import type { LimitId } from "../../../packages/execution/src/admission/refusal.js";
import type { Portfolio } from "../../../packages/strategy/src/enforcement/sizing.js";
import type { Runtime, TickResult } from "../../../packages/strategy/src/machines/index.js";
import { initialRuntime, tick } from "../../../packages/strategy/src/machines/index.js";
import type { Envelope, Plan } from "../../../packages/strategy/src/validation/schema.js";
import { validatePlan } from "../../../packages/strategy/src/validation/semantics.js";
import { assetOf, NAV_USD } from "../chain/index.js";
import {
  EXPIRED_ENVELOPE,
  SIGNED_ASSETS,
  STANDARD_ENVELOPE,
  T0,
  TIGHT_ENVELOPE,
} from "./envelopes.js";
import { type PermissionFixture, permissionOf } from "./permissions.js";
import {
  CONDITIONAL_BUY,
  EDGE_TRIGGERED,
  ENVELOPE_TRIPPER,
  LEVEL_TRIGGERED,
  MALFORMED_SCHEMA,
  MALFORMED_SEMANTICS,
  UNTRADABLE_ASSET,
} from "./plans.js";

/**
 * A library of authored strategies, each one a complete scenario: the plan as the user wrote
 * it, the envelope they signed, the permission they granted, and the sequence of market ticks
 * that makes the interesting thing happen.
 *
 * Every fixture carries the outcome it expects. That is not documentation — `strategies.test.ts`
 * runs each one through the real validator, the real tick and the real funding gate and
 * asserts against it, so a fixture that stops describing the product fails here rather than
 * quietly propagating a wrong assumption into every integration test that builds on it.
 */

const MINUTE = 60_000;

/** Positions are keyed by lowercase token address everywhere the observer writes them. */
export function portfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    // 2,500 USDC plus 5 AAPLc valued at the 320.08 oracle price.
    equity: "4100.4",
    positions: {
      [assetOf("AAPLc").token.toLowerCase()]: "5",
      [assetOf("MSFTc").token.toLowerCase()]: "0",
    },
    // Spendable USDC, which is NOT equity: a pct_equity buy sizes against stock too, so
    // without this an oversized buy is only discovered as a funding revert and a burnt fee.
    quote: "2500",
    ...overrides,
  };
}

/**
 * One tick's observation.
 *
 * `dex:MSFTc` is deliberately absent from every fixture: MSFTc has a live Chainlink reference
 * and no routable pool, so no venue price exists for it. Any plan that needs one is asking for
 * an observation the market cannot supply, and `evaluate` refuses the tick rather than reading
 * the gap as "condition not met" — which is exactly when a stop-loss must not go quiet.
 */
export function observation(aaplOracle: string): Readonly<Record<string, string>> {
  return {
    "oracle:AAPLc": aaplOracle,
    // The live producer emits a full-precision quotient (10 USDC over the shares a probe
    // returns). Rounded here for readability; nothing compares the two.
    "dex:AAPLc": "320.22",
    "oracle:MSFTc": NAV_USD.MSFTc ?? "428.6",
  };
}

export type TickInput = {
  readonly at: number;
  readonly feeds: Readonly<Record<string, string>>;
  readonly portfolio: Portfolio;
};

export type Expectation =
  | {
      readonly kind: "plan-invalid";
      /** Every issue code the validator must report, sorted. */
      readonly codes: readonly string[];
      /** Paths that must appear, so each issue is addressed at the rule that caused it. */
      readonly paths: readonly string[];
    }
  | {
      readonly kind: "ticks";
      /** Intents produced by each tick, in order. */
      readonly intents: readonly number[];
      /** Refusal strings each tick records, in order. */
      readonly refused: readonly (readonly string[])[];
      readonly halted: boolean;
      /**
       * Funding-gate limit ids, sorted. Present when a permission is attached.
       *
       * Typed as `LimitId` rather than `string` so a fixture that names a limit the gate
       * cannot emit is a type error here, not a test that silently asserts nothing.
       */
      readonly permissionRefusals?: readonly LimitId[];
      /** How the venue turns the resulting order away, when it cannot be filled at all. */
      readonly venue?: { readonly status: number; readonly detail: RegExp };
    };

export type StrategyFixture = {
  readonly id: string;
  readonly title: string;
  /** The failure this fixture exists to catch, in one sentence. */
  readonly why: string;
  readonly assets: readonly WireAsset[];
  /** Raw, unvalidated. The malformed fixtures must reach `validatePlan` as authored input. */
  readonly plan: unknown;
  readonly envelope: Envelope;
  readonly permission?: PermissionFixture;
  readonly ticks: readonly TickInput[];
  readonly expected: Expectation;
};

function ticksAt(prices: readonly string[], start = T0): TickInput[] {
  return prices.map((price, index) => ({
    at: start + index * MINUTE,
    feeds: observation(price),
    portfolio: portfolio(),
  }));
}

export const STRATEGIES: readonly StrategyFixture[] = [
  {
    id: "conditional-buy",
    title: "Buy 250 USDC of AAPLc when the reference price crosses below $325",
    why: "The baseline. If this stops producing exactly one intent, nothing else in the library means anything.",
    assets: SIGNED_ASSETS,
    plan: CONDITIONAL_BUY,
    envelope: STANDARD_ENVELOPE,
    permission: permissionOf("active"),
    ticks: ticksAt(["320.08"]),
    expected: {
      kind: "ticks",
      intents: [1],
      refused: [[]],
      halted: false,
      permissionRefusals: [],
    },
  },
  {
    id: "envelope-tripped",
    title: "Two 250 USDC orders against a 300 USDC period cap",
    why: "Only the second order is refused, and only because the first one's reservation is visible inside the same tick. A budget that re-read the persisted counters per action would admit both.",
    assets: SIGNED_ASSETS,
    plan: ENVELOPE_TRIPPER,
    envelope: TIGHT_ENVELOPE,
    permission: permissionOf("active"),
    ticks: ticksAt(["320.08"]),
    expected: {
      kind: "ticks",
      intents: [1],
      refused: [["Period cap exceeded"]],
      halted: false,
    },
  },
  {
    id: "expired-permission",
    title: "An armed strategy whose onchain grant ran out an hour ago",
    why: "The strategy layer still admits the order — nothing about the plan or the caps is wrong. The authority to pay for it is gone, and only the funding gate knows.",
    assets: SIGNED_ASSETS,
    plan: CONDITIONAL_BUY,
    envelope: STANDARD_ENVELOPE,
    permission: permissionOf("expired"),
    ticks: ticksAt(["320.08"]),
    expected: {
      kind: "ticks",
      intents: [1],
      refused: [[]],
      halted: false,
      permissionRefusals: ["permission.expired", "permission.inactive"],
    },
  },
  {
    id: "expired-mandate",
    title: "A strategy past its own expires_at",
    why: "Expiry is checked before evaluation and halts the instance: past the deadline no observation could justify an order, so there is nothing to compute.",
    assets: SIGNED_ASSETS,
    plan: CONDITIONAL_BUY,
    envelope: EXPIRED_ENVELOPE,
    permission: permissionOf("active"),
    ticks: ticksAt(["320.08"]),
    expected: {
      kind: "ticks",
      intents: [0],
      refused: [["Strategy expired"]],
      halted: true,
    },
  },
  {
    id: "untradable-asset",
    title: "An order on an allowlisted asset with no routable pool",
    why: "A valid plan, a valid envelope, a live reference price, and no venue. The order has to die at the quote, not at authoring time — liquidity can vanish after signing.",
    assets: SIGNED_ASSETS,
    plan: UNTRADABLE_ASSET,
    envelope: STANDARD_ENVELOPE,
    permission: permissionOf("active"),
    ticks: ticksAt(["320.08"]),
    expected: {
      kind: "ticks",
      intents: [1],
      refused: [[]],
      halted: false,
      venue: { status: 503, detail: /has liquidity/ },
    },
  },
  {
    id: "edge-triggered-once",
    title: "A guard that stays true must buy once per crossing",
    why: "The most expensive way to be wrong. 'Below $325' holds for hours; level-triggered evaluation buys on every tick until the period cap is gone.",
    assets: SIGNED_ASSETS,
    plan: EDGE_TRIGGERED,
    envelope: STANDARD_ENVELOPE,
    permission: permissionOf("active"),
    // true, still true, false, true again, still true.
    ticks: ticksAt(["320.08", "321", "330", "319", "318"]),
    expected: {
      kind: "ticks",
      intents: [1, 0, 0, 1, 0],
      refused: [[], [], [], [], []],
      halted: false,
    },
  },
  {
    id: "level-triggered-repeats",
    title: "The same guard, written to repeat, capped at two firings per episode",
    why: "Repetition is something an author can ask for, and when they do it carries a hard limit that resets when the guard goes false — so it bounds one episode, not the strategy's life.",
    assets: SIGNED_ASSETS,
    plan: LEVEL_TRIGGERED,
    envelope: STANDARD_ENVELOPE,
    permission: permissionOf("active"),
    ticks: ticksAt(["320.08", "321", "330", "319", "318"]),
    expected: {
      kind: "ticks",
      intents: [1, 1, 0, 1, 1],
      refused: [[], [], [], [], []],
      halted: false,
    },
  },
  {
    id: "malformed-semantics",
    title: "A plan that parses and cannot be signed",
    why: "Nine mistakes, nine issues, one pass. Reporting only the first would make fixing this a nine-round conversation with the compiler.",
    assets: SIGNED_ASSETS,
    plan: MALFORMED_SEMANTICS,
    envelope: STANDARD_ENVELOPE,
    ticks: [],
    expected: {
      kind: "plan-invalid",
      codes: [
        "asset-outside-allowlist",
        "guard-not-condition",
        "size-unit-mismatch",
        "unknown-feed",
        "unknown-state",
        "unreachable-state",
        "unsupported-action",
        "unsupported-scope",
        "unused-limit",
        "wrong-argument-count",
      ],
      paths: [
        "machines.0.scope",
        "machines.0.states.0.transitions.0.when",
        "machines.0.states.0.transitions.0.max_repeats",
        "machines.0.states.0.transitions.0.to",
        "machines.0.states.0.transitions.0.actions.0.asset",
        "machines.0.states.0.transitions.0.actions.1.size",
        "machines.0.states.0.transitions.0.actions.2",
        "machines.0.states.1",
        "nodes.1.args",
        "nodes.2.args.0",
      ],
    },
  },
  {
    id: "malformed-schema",
    title: "A plan that does not even parse",
    why: "A non-numeric parameter, an operator that does not exist and a negative order size — what a hand-edited or hallucinated plan actually gets wrong. Each must come back naming its field.",
    assets: SIGNED_ASSETS,
    plan: MALFORMED_SCHEMA,
    envelope: STANDARD_ENVELOPE,
    ticks: [],
    expected: {
      kind: "plan-invalid",
      codes: ["schema-custom", "schema-invalid_format", "schema-invalid_value"],
      paths: [
        "params.0.value",
        "nodes.0.op",
        "machines.0.states.0.transitions.0.actions.0.size.value",
      ],
    },
  },
];

export function strategyOf(id: string): StrategyFixture {
  const fixture = STRATEGIES.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`No strategy fixture ${id}`);
  return fixture;
}

/** Validate a fixture's plan against its own signed allowlist. Throws `PlanInvalid` by design. */
export function planOf(fixture: StrategyFixture): Plan {
  return validatePlan(fixture.plan, [...fixture.assets]);
}

export type Replay = { readonly runtime: Runtime; readonly results: readonly TickResult[] };

/**
 * Run every tick of a fixture in order, threading the runtime through.
 *
 * Threading is the whole point: edge memory, period counters and the machine's current state
 * all live in the runtime, so replaying against a fresh one each time would make every
 * multi-tick fixture assert the first tick five times.
 */
export function replay(fixture: StrategyFixture): Replay {
  const first = fixture.ticks[0];
  if (!first) throw new Error(`Fixture ${fixture.id} has no ticks to replay`);
  const plan = planOf(fixture);
  let runtime = initialRuntime(plan, first.at);
  const results: TickResult[] = [];
  for (const input of fixture.ticks) {
    const result = tick(plan, fixture.envelope, runtime, input.feeds, input.portfolio, input.at);
    results.push(result);
    runtime = result.state;
  }
  return { runtime, results };
}
