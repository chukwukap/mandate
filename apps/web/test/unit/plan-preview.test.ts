import { describe, expect, test } from "bun:test";
import type { StrategyForm } from "../../src/features/strategies/authoring";
import { project } from "../../src/features/strategies/plan-preview";

const PRICES: Record<string, string> = { AAPLc: "300", NVDAc: "200", TSLAc: "400" };
const price = (s: string) => PRICES[s];

const base: StrategyForm = {
  name: "",
  symbols: ["AAPLc"],
  shape: "levels",
  direction: "lt",
  thresholds: {},
  discountBps: "20",
  cadenceHours: "168",
  ladderStart: "",
  ladderStepPct: "4",
  ladderMultiple: "2",
  ladderRungs: "4",
  amount: "50",
  budget: "500",
  days: "30",
  mode: "manual",
  authoring: "rule",
  prompt: "",
  dailyBudget: "",
  maxOrders: "10",
  cooldownMinutes: "60",
  slippageBps: "50",
};

describe("what this strategy would do today", () => {
  test("a level below spot is reported as waiting, not as firing", () => {
    const p = project({ ...base, thresholds: { AAPLc: "250" } }, price, "1000");
    expect(p?.today?.firing).toBe(false);
    expect(p?.sentence).toContain("$50");
  });

  test("a level already met says so, because that buys on the next check", () => {
    const p = project({ ...base, thresholds: { AAPLc: "350" } }, price, "1000");
    expect(p?.today?.firing).toBe(true);
    expect(p?.today?.detail).toMatch(/AAPL/);
  });

  test("a budget larger than the wallet is called out with both numbers", () => {
    const p = project({ ...base, thresholds: { AAPLc: "250" }, budget: "5000" }, price, "1000");
    expect(p?.warnings.join(" ")).toMatch(/\$5,000.*\$1,000|\$1,000.*\$5,000/);
  });

  test("a buy larger than the whole budget is refused as impossible", () => {
    const p = project({ ...base, amount: "600", budget: "500" }, price, "10000");
    expect(p?.warnings.join(" ")).toMatch(/larger than the total budget/i);
  });

  /**
   * The dangerous ladder. Every rung above spot means every rung is already true, so the machine
   * walks the whole chain in minutes and spends the entire commitment at one price — the precise
   * failure a scale-in exists to avoid, and easy to reach because the first-step field is
   * prefilled with today's price.
   */
  test("a ladder entirely above today's price warns that it fires all at once", () => {
    const p = project(
      { ...base, shape: "ladder", symbols: ["AAPLc"], ladderStart: "400", amount: "40" },
      price,
      "10000",
    );
    const warnings = p?.warnings.join(" ") ?? "";
    expect(warnings).toMatch(/all 4 would trigger at once/i);
    expect(warnings).toMatch(/straight away/i);
  });

  test("a ladder starting below spot does not raise that warning", () => {
    const p = project(
      { ...base, shape: "ladder", symbols: ["AAPLc"], ladderStart: "280", amount: "40" },
      price,
      "10000",
    );
    expect(p?.warnings.join(" ")).not.toMatch(/trigger at once/i);
  });

  test("a ladder always says the largest single buy, which is not the amount typed", () => {
    const p = project(
      { ...base, shape: "ladder", symbols: ["AAPLc"], ladderStart: "280", amount: "40" },
      price,
      "10000",
    );
    // 40, 80, 160, 320 at a 2x multiple — the signed per-order cap is 320, not the 40 typed.
    expect(p?.facts.find((f) => f.label === "Largest single buy")?.value).toBe("$320.00");
  });

  test("a ladder always states that nothing sells it back", () => {
    const p = project(
      { ...base, shape: "ladder", symbols: ["AAPLc"], ladderStart: "280" },
      price,
      "10000",
    );
    expect(p?.warnings.join(" ")).toMatch(/nothing sells this back/i);
  });

  test("recurring says how long the money lasts at the chosen pace", () => {
    const p = project(
      { ...base, shape: "recurring", cadenceHours: "168", amount: "50", budget: "500" },
      price,
      "10000",
    );
    // 10 buys, one a week, is about 70 days — which outlasts a 30-day run.
    expect(p?.facts.find((f) => f.label === "Budget lasts about")?.value).toMatch(/70 days/);
    expect(p?.warnings.join(" ")).toMatch(/outlasts the strategy/i);
  });

  test("rebalancing states the ceiling it cannot pass", () => {
    const p = project(
      { ...base, shape: "rebalance", symbols: ["AAPLc", "NVDAc", "TSLAc"] },
      price,
      "10000",
    );
    expect(p?.sentence).toMatch(/33% each/);
    expect(p?.warnings.join(" ")).toMatch(/never sells/i);
  });

  test("the plain-English mode has nothing to project from, and says nothing", () => {
    expect(project({ ...base, authoring: "text" }, price, "1000")).toBeNull();
  });

  test("a missing price never invents one", () => {
    const p = project(
      { ...base, symbols: ["AAPLc"], thresholds: { AAPLc: "250" } },
      () => undefined,
      null,
    );
    expect(p?.today).toBeNull();
    expect(JSON.stringify(p)).not.toContain("NaN");
  });
});
