import { expect, test } from "bun:test";
import { units } from "../src/evaluation/index.js";
import type { Asset, PlanIssue } from "../src/validation/index.js";
import { capsSchema, envelopeSchema, PlanInvalid, validatePlan } from "../src/validation/index.js";

const AAPL: Asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}`,
  feed: `0x${"22".repeat(20)}`,
  decimals: 8,
};
const NVDA: Asset = {
  symbol: "NVDAc",
  token: `0x${"33".repeat(20)}`,
  feed: `0x${"44".repeat(20)}`,
  decimals: 8,
};

const below = {
  id: "below",
  op: "lt",
  args: [
    { kind: "feed", feed: "oracle:AAPLc" },
    { kind: "const", value: "200" },
  ],
};
const notify = { action: "notify", message: "Price condition met" };

function machine(transitions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "m",
    scope: "portfolio",
    initial: "watch",
    states: [{ id: "watch", transitions }],
    ...extra,
  };
}
function base(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [below],
    machines: [machine([{ when: "below", to: "watch", actions: [notify] }])],
    ...overrides,
  };
}
/** Every issue a plan produced, or a failure if it was unexpectedly accepted. */
function issues(input: unknown, assets: readonly Asset[] = [AAPL]): PlanIssue[] {
  try {
    validatePlan(input, assets);
  } catch (error) {
    if (error instanceof PlanInvalid) return [...error.issues];
    throw error;
  }
  throw new Error("Expected the plan to be rejected");
}
function codes(input: unknown, assets: readonly Asset[] = [AAPL]): string[] {
  return issues(input, assets).map((i) => i.code);
}

test("a valid plan is accepted and defaults are filled in", () => {
  const plan = validatePlan(base(), [AAPL]);
  expect(plan.params).toEqual([]);
  expect(plan.machines[0]?.states[0]?.transitions[0]?.fires).toBe("on_edge");
});

test("a rejected plan is a 400 Problem carrying a pointer per failure", () => {
  let thrown: unknown;
  try {
    validatePlan(
      base({ machines: [machine([{ when: "below", to: "elsewhere", actions: [notify] }])] }),
      [AAPL],
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PlanInvalid);
  const problem = thrown as PlanInvalid;
  expect(problem.status).toBe(400);
  expect(problem.code).toBe("invalid-plan");
  // The path is what lets a client highlight the offending rule rather than
  // reprinting the whole plan.
  expect(problem.issues[0]?.path).toBe("machines.0.states.0.transitions.0.to");
  expect(problem.detail).toContain("Unknown target state: elsewhere");
});

test("a schema failure arrives as dotted issues, not a raw ZodError blob", () => {
  const found = issues(base({ nodes: [{ ...below, op: "power" }] }));
  expect(found).toHaveLength(1);
  expect(found[0]?.path).toBe("nodes.0.op");
  expect(found[0]?.code).toStartWith("schema-");
});

test("a node may only use nodes declared above it", () => {
  const found = issues(
    base({ nodes: [{ id: "self", op: "not", args: [{ kind: "node", node: "self" }] }] }),
  );
  // Refusing a forward reference is also what makes a cycle impossible.
  expect(found[0]?.message).toContain("forward node");
  expect(found[0]?.path).toBe("nodes.0.args.0");
});

test("only feeds the signed asset catalogue can supply are allowed", () => {
  const found = issues(
    base({
      nodes: [
        {
          ...below,
          args: [
            { kind: "feed", feed: "oracle:UNKNOWN" },
            { kind: "const", value: "200" },
          ],
        },
      ],
    }),
  );
  expect(found[0]?.message).toContain("Unavailable feed");
  // The message lists what is available so the author can fix it in one pass.
  expect(found[0]?.message).toContain("oracle:AAPLc");
});

test("arity comes from the operator table, so validation and evaluation cannot disagree", () => {
  const short = issues(
    base({
      nodes: [
        {
          id: "d",
          op: "safe_div",
          args: [
            { kind: "const", value: "1" },
            { kind: "const", value: "2" },
          ],
        },
        below,
      ],
    }),
  );
  expect(short[0]?.code).toBe("wrong-argument-count");
  expect(short[0]?.message).toContain("exactly 3 arguments");
  const single = issues(
    base({ nodes: [{ id: "s", op: "add", args: [{ kind: "const", value: "1" }] }, below] }),
  );
  expect(single[0]?.message).toContain("between 2 and 32 arguments");
});

test("numbers and conditions cannot be mixed", () => {
  const found = issues(
    base({
      nodes: [
        below,
        {
          id: "bad",
          op: "and",
          args: [
            { kind: "node", node: "below" },
            { kind: "const", value: "1" },
          ],
        },
      ],
    }),
  );
  expect(found[0]?.code).toBe("type-mismatch");
  expect(found[0]?.message).toContain("argument 2 is a number");
  const guard = issues(
    base({
      nodes: [
        {
          id: "sum",
          op: "add",
          args: [
            { kind: "const", value: "1" },
            { kind: "const", value: "2" },
          ],
        },
      ],
      machines: [machine([{ when: "sum", to: "watch", actions: [notify] }])],
    }),
  );
  expect(guard.map((i) => i.code)).toContain("guard-not-condition");
});

test("machine wiring is checked against the states that exist", () => {
  expect(
    codes(
      base({
        machines: [
          machine([{ when: "below", to: "watch", actions: [notify] }], { initial: "ghost" }),
        ],
      }),
    ),
  ).toContain("unknown-state");
  expect(
    codes(base({ machines: [machine([{ when: "missing", to: "watch", actions: [notify] }])] })),
  ).toContain("unknown-node");
  expect(
    codes(
      base({
        machines: [
          machine([{ when: "below", to: "watch", actions: [notify] }], { scope: "position" }),
        ],
      }),
    ),
  ).toContain("unsupported-scope");
});

test("a machine that can never act, or a state nothing can enter, is refused", () => {
  // A signed strategy that provably cannot act is worse than an error: the user
  // believes it is working.
  expect(codes(base({ machines: [machine([])] }))).toContain("inert-machine");
  const orphan = base({
    machines: [
      {
        id: "m",
        scope: "portfolio",
        initial: "watch",
        states: [
          { id: "watch", transitions: [{ when: "below", to: "watch", actions: [notify] }] },
          { id: "orphan", transitions: [{ when: "below", to: "watch", actions: [notify] }] },
        ],
      },
    ],
  });
  const found = issues(orphan);
  expect(found[0]?.code).toBe("unreachable-state");
  expect(found[0]?.message).toContain("orphan");
});

test("repeat limits must match the firing mode they are written against", () => {
  expect(
    codes(
      base({
        machines: [
          machine([{ when: "below", fires: "while_true", to: "watch", actions: [notify] }]),
        ],
      }),
    ),
  ).toContain("missing-limit");
  // An on_edge rule never consults max_repeats. Accepting it would let an author
  // believe they capped a rule that is in fact uncapped.
  expect(
    codes(
      base({
        machines: [
          machine([
            { when: "below", fires: "on_edge", max_repeats: 3, to: "watch", actions: [notify] },
          ]),
        ],
      }),
    ),
  ).toContain("unused-limit");
  expect(() =>
    validatePlan(
      base({
        machines: [
          machine([
            { when: "below", fires: "while_true", max_repeats: 3, to: "watch", actions: [notify] },
          ]),
        ],
      }),
      [AAPL],
    ),
  ).not.toThrow();
});

test("order actions must address a signed asset and use that side's size unit", () => {
  const order = (extra: Record<string, unknown>) =>
    base({
      machines: [
        machine([
          {
            when: "below",
            to: "watch",
            actions: [
              {
                action: "order",
                asset: 0,
                side: "buy",
                size: { unit: "quote", value: "10" },
                ...extra,
              },
            ],
          },
        ]),
      ],
    });
  // A buy spends USDC; a sell sends stock. Crossing them would size an order in
  // the wrong token entirely.
  expect(codes(order({ size: { unit: "base", value: "1" } }))).toContain("size-unit-mismatch");
  expect(codes(order({ side: "sell", size: { unit: "quote", value: "10" } }))).toContain(
    "size-unit-mismatch",
  );
  expect(codes(order({ asset: 1 }))).toContain("asset-outside-allowlist");
  expect(() => validatePlan(order({ asset: 1 }), [AAPL, NVDA])).not.toThrow();
});

test("stored variables are refused, because nothing can read them back", () => {
  const found = issues(
    base({
      nodes: [
        below,
        {
          id: "sum",
          op: "add",
          args: [
            { kind: "const", value: "1" },
            { kind: "const", value: "2" },
          ],
        },
      ],
      machines: [
        machine([
          { when: "below", to: "watch", actions: [{ action: "set", var: "x", value: "sum" }] },
        ]),
      ],
    }),
  );
  expect(found[0]?.code).toBe("unsupported-action");
  expect(found[0]?.message).toContain("nothing can read them back");
});

test("a catalogue with a repeated symbol or token is refused before the plan is read", () => {
  // Feeds are keyed by symbol and positions by token: two entries sharing either
  // would read the same price or spend the same balance twice.
  const bySymbol = issues(base(), [AAPL, { ...NVDA, symbol: "AAPLc" }]);
  expect(bySymbol[0]?.code).toBe("duplicate-asset");
  expect(bySymbol[0]?.message).toContain("read the same price");
  const byToken = issues(base(), [
    AAPL,
    { ...NVDA, token: AAPL.token.toUpperCase() as Asset["token"] },
  ]);
  expect(byToken[0]?.message).toContain("spend the same balance twice");
  expect(issues(base(), [])[0]?.code).toBe("empty-catalogue");
});

test("duplicate identifiers are refused rather than silently shadowed", () => {
  expect(codes(base({ nodes: [below, below] }))).toContain("duplicate-id");
  expect(
    codes(
      base({
        machines: [
          machine([{ when: "below", to: "watch", actions: [notify] }]),
          machine([{ when: "below", to: "watch", actions: [notify] }]),
        ],
      }),
    ),
  ).toContain("duplicate-id");
});

test("every failure in one pass, not just the first", () => {
  const found = issues(
    base({
      machines: [
        machine([
          { when: "below", to: "nowhere", actions: [notify] },
          {
            when: "below",
            fires: "while_true",
            to: "watch",
            actions: [
              { action: "order", asset: 9, side: "buy", size: { unit: "base", value: "1" } },
            ],
          },
        ]),
      ],
    }),
  );
  expect(found.map((i) => i.code).sort()).toEqual([
    "asset-outside-allowlist",
    "missing-limit",
    "size-unit-mismatch",
    "unknown-state",
  ]);
});

test("caps keep USDC's six decimals, their ordering and onchain allowance capacity", () => {
  const caps = {
    lifetime: "100",
    per_order: "10",
    per_period: "20",
    period_secs: 86400,
    max_orders_per_period: 2,
    cooldown_secs: 60,
    expires_at: "2027-01-01T00:00:00Z",
  };
  expect(capsSchema.parse(caps).slippage_bps).toBe(50);
  expect(() => capsSchema.parse({ ...caps, per_order: "21" })).toThrow();
  expect(() => capsSchema.parse({ ...caps, per_order: "0.0000001" })).toThrow();
  // What actually bounds a cap below SpendPermissionManager's uint160 allowance is
  // the 40-digit decimal shape, not the explicit uint160 refinement: 1e40 USDC is
  // 1e46 units against a 2^160 ≈ 1.46e48 ceiling, so the refinement can never fire
  // while this regex stands. The regex is therefore the load-bearing check.
  expect(() => capsSchema.parse({ ...caps, lifetime: "1".repeat(41) })).toThrow();
  expect(capsSchema.parse({ ...caps, lifetime: "1".repeat(40) }).lifetime).toHaveLength(40);
  expect(units("1".repeat(40), 6) < 2n ** 160n).toBe(true);
});

test("the whole envelope re-parses, so a stale JSONB row is refused rather than ticked on", () => {
  const envelope = {
    version: "mandate/2",
    caps: capsSchema.parse({
      lifetime: "100",
      per_order: "10",
      per_period: "20",
      period_secs: 86400,
      max_orders_per_period: 2,
      cooldown_secs: 60,
      expires_at: "2027-01-01T00:00:00Z",
    }),
    assets: [AAPL],
    quote: `0x${"55".repeat(20)}`,
    venue: "aerodrome",
  };
  expect(envelopeSchema.parse(envelope).assets[0]?.decimals).toBe(8);
  expect(() => envelopeSchema.parse({ ...envelope, version: "mandate/1" })).toThrow();
  expect(() => envelopeSchema.parse({ ...envelope, assets: [] })).toThrow();
  expect(() =>
    envelopeSchema.parse({ ...envelope, assets: [{ ...AAPL, token: "0xnope" }] }),
  ).toThrow();
});
