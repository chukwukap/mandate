import { describe, expect, test } from "bun:test";
import { draftInput, type StrategyForm } from "../../src/features/strategies/authoring";

const form: StrategyForm = {
  name: "My entry",
  symbol: "NVDAc",
  direction: "lt",
  threshold: "220.000001",
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
      threshold: "",
    });
    expect("prompt" in input && input.prompt).toBe("Sell if the reference rises above 250.");
    expect("plan" in input).toBe(false);
    expect(input.caps.lifetime).toBe("1");
    expect(() => draftInput({ ...form, authoring: "text", prompt: " " })).toThrow();
  });
});
