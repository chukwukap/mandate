import { describe, expect, test } from "bun:test";
import { draftInput, type StrategyForm } from "../../src/features/strategies/authoring";

const form: StrategyForm = {
  name: "My entry",
  symbols: ["NVDAc"],
  shape: "levels",
  direction: "lt",
  thresholds: { NVDAc: "220.000001" },
  discountBps: "20",
  cadenceHours: "24",
  ladderStart: "300",
  ladderStepPct: "3",
  ladderMultiple: "1.5",
  ladderRungs: "4",
  amount: "0.000001",
  budget: "1",
  days: "30",
  mode: "manual",
  authoring: "rule",
  prompt: "",
  dailyBudget: "0.000001",
  maxOrders: "2",
  cooldownMinutes: "60",
  slippageBps: "50",
};
describe("strategy authoring boundary", () => {
  test("preserves micro-USDC precision and chosen limits", () => {
    const input = draftInput(form, 0);
    expect(input.caps.per_order).toBe("0.000001");
    expect(input.caps.per_period).toBe("0.000001");
    expect(input.caps.max_orders_per_period).toBe(2);
    expect(input.caps.cooldown_secs).toBe(3600);
    expect(input.caps.expires_at).toBe("1970-01-31T00:00:00.000Z");
  });
  test("rejects sub-micro amounts and inconsistent budgets before requesting a signature", () => {
    for (const amount of ["0", "0.0000001", "-1", "NaN", "1e10"])
      expect(() => draftInput({ ...form, amount })).toThrow();
    expect(() => draftInput({ ...form, dailyBudget: "2" })).toThrow();
    expect(() => draftInput({ ...form, amount: "0.000002" })).toThrow();
    expect(() => draftInput({ ...form, slippageBps: "501" })).toThrow();
  });
  test("compares large decimal budgets exactly instead of rounding through Number", () => {
    expect(() =>
      draftInput({
        ...form,
        amount: "9007199254740992.000002",
        dailyBudget: "9007199254740992.000001",
        budget: "9007199254740993",
      }),
    ).toThrow();
  });
  test("text authoring forwards user intent with caps, without inventing a plan", () => {
    const input = draftInput({
      ...form,
      authoring: "text",
      prompt: " Sell if the reference rises above 250. ",
      thresholds: {},
    });
    expect("prompt" in input && input.prompt).toBe("Sell if the reference rises above 250.");
    expect("plan" in input).toBe(false);
    expect(input.caps.lifetime).toBe("1");
    expect(() => draftInput({ ...form, authoring: "text", prompt: " " })).toThrow();
  });
});

/**
 * A basket is the shape people actually ask for — "buy the dip on Apple, NVIDIA and Tesla" —
 * and every guarantee below is one the engine enforces rather than a preference. They are
 * asserted here because the failure mode of getting them wrong is silent: a plan that validates,
 * signs, and then buys the wrong company.
 */
describe("multi-token authoring", () => {
  const basket: StrategyForm = {
    ...form,
    symbols: ["AAPLc", "NVDAc", "TSLAc"],
    thresholds: { AAPLc: "200", NVDAc: "150", TSLAc: "300" },
  };
  test("sends the selection as the envelope's assets, in the order picked", () => {
    expect(draftInput(basket, 0).assets).toEqual(["AAPLc", "NVDAc", "TSLAc"]);
  });
  test("addresses each order by its index in that same array", () => {
    const input = draftInput(basket, 0);
    if (!("plan" in input)) throw new Error("expected a plan");
    // An `order` action names its asset by INDEX. If these ever drift apart the strategy stays
    // valid and buys a different company than the one whose price triggered it.
    const ordered = input.plan.machines.map((machine) => {
      const action = machine.states[0]?.transitions[0]?.actions[0];
      if (action?.action !== "order") throw new Error("expected an order");
      return input.assets[action.asset];
    });
    expect(ordered).toEqual(["AAPLc", "NVDAc", "TSLAc"]);
  });
  test("gives every asset its own machine, so a shared tick cannot serialise them", () => {
    // At most one transition fires per machine per tick. Three assets in one machine would fill
    // one per cadence interval when the market gaps and all three conditions turn true at once.
    expect(draftInput(basket, 0)).toHaveProperty("plan.machines.length", 3);
  });
  test("keeps each asset's own price rather than reusing one across the basket", () => {
    const input = draftInput(basket, 0);
    if (!("plan" in input)) throw new Error("expected a plan");
    expect(input.plan.nodes.map((node) => node.args[1])).toEqual([
      { kind: "const", value: "200" },
      { kind: "const", value: "150" },
      { kind: "const", value: "300" },
    ]);
  });
  test("names the asset whose price is missing", () => {
    expect(() => draftInput({ ...basket, thresholds: { AAPLc: "200", TSLAc: "300" } })).toThrow(
      /NVDAc/,
    );
  });
  test("refuses an empty basket, an unknown ticker, and more machines than a plan can hold", () => {
    expect(() => draftInput({ ...basket, symbols: [] })).toThrow(/at least one/);
    expect(() => draftInput({ ...basket, symbols: ["AAPLc", "DOGEc"] })).toThrow(/DOGEc/);
    expect(() =>
      draftInput({ ...basket, symbols: Array.from({ length: 17 }, (_, i) => `AAPL${i}c`) }),
    ).toThrow(/at most 16/);
  });
  test("deduplicates, so the same stock picked twice cannot double its own order size", () => {
    expect(draftInput({ ...basket, symbols: ["AAPLc", "AAPLc", "NVDAc"] }, 0).assets).toEqual([
      "AAPLc",
      "NVDAc",
    ]);
  });
  test("the discount shape needs no per-asset price and guards against a dead reference", () => {
    const input = draftInput({ ...basket, shape: "discount", thresholds: {} }, 0);
    if (!("plan" in input)) throw new Error("expected a plan");
    expect(input.plan.machines).toHaveLength(3);
    // safe_div's third argument is the value used when the oracle reads zero. 0 fails the
    // sanity floor, so an unusable reference declines to trade instead of reading as a 100%
    // discount and firing on every asset at once.
    const basis = input.plan.nodes.find((node) => node.id === "basis_AAPLc");
    expect(basis?.args[2]).toEqual({ kind: "const", value: "0" });
    expect(() => draftInput({ ...basket, shape: "discount", discountBps: "0" })).toThrow();
  });
});

/**
 * The bot-shaped strategies. Each is checked for the one property that makes it that strategy
 * rather than a rule that happens to resemble it.
 */
describe("recurring, ladder and rebalance shapes", () => {
  const base: StrategyForm = { ...form, symbols: ["AAPLc", "NVDAc"], thresholds: {} };

  test("a recurring plan is paced by the cooldown, because the engine has no clock", () => {
    const input = draftInput({ ...base, shape: "recurring", cadenceHours: "24" }, 0);
    // The cadence is not in the plan at all — it is the cap. That is the mechanism.
    expect(input.caps.cooldown_secs).toBe(86_400);
    if (!("plan" in input)) throw new Error("expected a plan");
    // Always-true condition, repeating rather than edge-triggered: an edge fires once, which
    // would be a single purchase rather than a schedule.
    expect(input.plan.nodes).toHaveLength(1);
    for (const machine of input.plan.machines)
      expect(machine.states[0]?.transitions[0]?.fires).toBe("while_true");
    expect(draftInput({ ...base, shape: "recurring", cadenceHours: "1" }, 0).caps.cooldown_secs).toBe(3600);
    expect(() => draftInput({ ...base, shape: "recurring", cadenceHours: "0" })).toThrow();
  });

  test("the cooldown field still governs every other shape", () => {
    expect(draftInput({ ...base, shape: "discount", cooldownMinutes: "30" }, 0).caps.cooldown_secs).toBe(1800);
  });

  test("a ladder steps down in price and up in size, and ends terminal", () => {
    const input = draftInput(
      { ...base, symbols: ["AAPLc"], shape: "ladder", ladderStart: "300", ladderStepPct: "10",
        ladderMultiple: "2", ladderRungs: "3", amount: "25",
        dailyBudget: "175", budget: "175" },
      0,
    );
    if (!("plan" in input)) throw new Error("expected a plan");
    expect(input.plan.nodes.map((n) => n.args[1])).toEqual([
      { kind: "const", value: "300.000000" },
      { kind: "const", value: "270.000000" },
      { kind: "const", value: "243.000000" },
    ]);
    const sizes = input.plan.machines[0]?.states.flatMap((s) =>
      s.transitions.flatMap((tr) => tr.actions.map((a) => ("size" in a ? a.size.value : ""))),
    );
    expect(sizes).toEqual(["25.00", "50.00", "100.00"]);
    // The last rung goes somewhere with no transitions. Nothing can sell this back, so the
    // ladder must stop rather than loop.
    const terminal = input.plan.machines[0]?.states.at(-1);
    expect(terminal?.transitions).toEqual([]);
  });

  test("a ladder refuses a basket, because its rungs address one stock", () => {
    expect(() =>
      draftInput({ ...base, shape: "ladder", ladderStart: "300" }),
    ).toThrow(/one stock at a time/);
  });

  test("the per-order cap is the largest rung, so no rung can be refused by it", () => {
    const input = draftInput(
      { ...base, symbols: ["AAPLc"], shape: "ladder", ladderStart: "300", ladderStepPct: "10",
        ladderMultiple: "2", ladderRungs: "3", amount: "25", dailyBudget: "175", budget: "175" },
      0,
    );
    // 25, 50, 100 — the cap has to clear 100 or the deepest rungs never fill.
    expect(input.caps.per_order).toBe("100.00");
  });

  test("a ladder refuses nonsense scaling rather than signing it", () => {
    const ladder = { ...base, symbols: ["AAPLc"], shape: "ladder" as const, ladderStart: "300" };
    expect(() => draftInput({ ...ladder, ladderStepPct: "0" })).toThrow(/Step size/);
    expect(() => draftInput({ ...ladder, ladderStepPct: "80" })).toThrow(/Step size/);
    expect(() => draftInput({ ...ladder, ladderMultiple: "0.5" })).toThrow(/multiple/);
    expect(() => draftInput({ ...ladder, ladderMultiple: "9" })).toThrow(/multiple/);
  });

  test("rebalancing splits equally and gates on cash rather than equity", () => {
    const input = draftInput({ ...base, symbols: ["AAPLc", "NVDAc", "TSLAc"], shape: "rebalance" }, 0);
    if (!("plan" in input)) throw new Error("expected a plan");
    const target = input.plan.nodes.find((n) => n.id === "under_AAPLc");
    expect(target?.args[1]).toEqual({ kind: "const", value: "0.333300" });
    // Equity counts stock and stock cannot be spent, so the affordability test reads `cash`.
    expect(input.plan.nodes.find((n) => n.id === "funded_AAPLc")?.args[0]).toEqual({
      kind: "feed",
      feed: "cash",
    });
    // An empty account must read as fully weighted, not as underweight — the fallback decides
    // whether a zero-equity wallet buys everything or nothing.
    expect(input.plan.nodes.find((n) => n.id === "weight_AAPLc")?.args[2]).toEqual({
      kind: "const",
      value: "1",
    });
  });
});
