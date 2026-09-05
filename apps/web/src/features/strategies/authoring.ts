import { stocks } from "../market/catalog";
import { makePlan } from "./plan";
export type StrategyForm = {
  name: string;
  symbol: string;
  direction: "lt" | "gt";
  threshold: string;
  amount: string;
  budget: string;
  days: string;
  mode: "manual" | "auto";
  authoring: "rule" | "text";
  prompt: string;
  dailyBudget: string;
  maxOrders: string;
  cooldownMinutes: string;
  slippageBps: string;
};
function amount(value: string, label: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || value.length > 54)
    throw new Error(`${label} must be a positive amount with at most six decimal places.`);
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole ?? "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (units <= 0n || units >= 2n ** 160n)
    throw new Error(`${label} is outside the supported range.`);
  return units;
}
function integer(value: string, min: number, max: number, label: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return result;
}
export function draftInput(form: StrategyForm, now = Date.now()) {
  if (!stocks.includes(form.symbol)) throw new Error("Choose a supported stock.");
  const perOrder = amount(form.amount, "Per-order limit");
  const total = amount(form.budget, "Total budget");
  const perDay = amount(form.dailyBudget || form.budget, "Daily budget");
  if (perOrder > perDay || perDay > total)
    throw new Error(
      "Keep the per-order limit within the daily budget, and the daily budget within the total.",
    );
  if (form.authoring === "rule") amount(form.threshold, "Target price");
  if (form.authoring === "text" && (!form.prompt.trim() || form.prompt.length > 4000))
    throw new Error("Describe your strategy in 1–4,000 characters.");
  return {
    name: form.name.trim() || `${form.symbol} strategy`,
    assets: [form.symbol],
    mode: form.mode,
    ...(form.authoring === "text"
      ? { prompt: form.prompt.trim() }
      : { plan: makePlan(form.symbol, form.direction, form.threshold, form.amount) }),
    caps: {
      lifetime: form.budget,
      per_order: form.amount,
      per_period: form.dailyBudget || form.budget,
      period_secs: 86400,
      max_orders_per_period: integer(form.maxOrders, 1, 10000, "Daily order limit"),
      cooldown_secs: integer(form.cooldownMinutes, 0, 525600, "Cooldown") * 60,
      expires_at: new Date(now + integer(form.days, 1, 365, "Duration") * 86400000).toISOString(),
      slippage_bps: integer(form.slippageBps, 1, 500, "Slippage limit"),
    },
  };
}
