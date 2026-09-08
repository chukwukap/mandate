import { stocks } from "../market/catalog";
import { discountPlan, ladderPlan, levelsPlan, rebalancePlan, recurringPlan } from "./plan";

/**
 * A plan gets one state machine per selected asset, and `planSchema` caps machines at 16 while
 * capping assets at 20. The stricter of the two is the real limit on a basket, so it is enforced
 * here — where the message can say something useful — rather than surfacing from the API as a
 * schema rejection on a strategy the user already filled in.
 */
export const MAX_ASSETS = 16;

export type StrategyForm = {
  name: string;
  /** A basket. One entry is the common case, not a special case. */
  symbols: string[];
  /** Which rule shape the structured builder emits. Ignored when authoring from text. */
  shape: "levels" | "discount" | "recurring" | "ladder" | "rebalance";
  /** Recurring only: hours between buys. This becomes the envelope's cooldown, which is the
   *  mechanism — the engine has no clock, so the cap is what paces the rule. */
  cadenceHours: string;
  /** Ladder only. The first rung triggers under `ladderStart`; each next rung is `ladderStepPct`
   *  further down and `ladderMultiple` times larger. */
  ladderStart: string;
  ladderStepPct: string;
  ladderMultiple: string;
  ladderRungs: string;
  direction: "lt" | "gt";
  /** Per-symbol target price for the `levels` shape. Keyed by symbol, not by index, so
   *  deselecting one asset cannot silently shift another asset's price onto it. */
  thresholds: Record<string, string>;
  /** How far under the Chainlink reference the pool has to be, for the `discount` shape. */
  discountBps: string;
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

/**
 * `value * factor`, in exact micro-USDC.
 *
 * For preview copy only, and deliberately not `Number(value) * factor`: at the amounts this form
 * accepts that is 0.000001 * 3 = 0.0000000000000030000000000000004, which is a number no one
 * should be shown next to a spending limit. Returns null while the field is still being typed,
 * so the caller renders nothing rather than "NaN".
 */
export function scaleAmount(value: string, factor: number): string | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || value.length > 54) return null;
  const [whole, fraction = ""] = value.split(".");
  const micro =
    (BigInt(whole ?? "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"))) * BigInt(factor);
  if (micro <= 0n) return null;
  const cents = (micro / 10_000n).toString().padStart(3, "0");
  return `${cents.slice(0, -2)}.${cents.slice(-2)}`;
}

function integer(value: string, min: number, max: number, label: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return result;
}

/** The order the user picked, deduplicated — it becomes the envelope's `assets` array, and an
 *  `order` action addresses an asset by its INDEX in that array. */
function selection(form: StrategyForm) {
  const symbols = [...new Set(form.symbols)];
  if (symbols.length === 0) throw new Error("Choose at least one stock.");
  if (symbols.length > MAX_ASSETS)
    throw new Error(`Choose at most ${MAX_ASSETS} stocks for a single strategy.`);
  for (const symbol of symbols)
    if (!stocks.includes(symbol)) throw new Error(`${symbol} is not a supported stock.`);
  return symbols;
}

function name(form: StrategyForm, symbols: string[]) {
  const trimmed = form.name.trim();
  if (trimmed) return trimmed;
  if (symbols.length === 1) return `${symbols[0]} strategy`;
  if (symbols.length === stocks.length) return "Every stock strategy";
  return `${symbols.slice(0, 2).join(" + ")}${symbols.length > 2 ? ` +${symbols.length - 2}` : ""} strategy`;
}

/**
 * The rungs a ladder will actually buy, derived from the four numbers a user types.
 *
 * Exported because the editor previews them: a scale-in whose total spend is not shown before
 * signing is a strategy whose most important number is hidden. Sizes are rounded to the cent —
 * a multiple of 1.5 over five rungs otherwise produces amounts no one would choose to sign.
 */
export function ladderRungs(form: StrategyForm) {
  const count = integer(form.ladderRungs, 1, 24, "Number of steps");
  const stepPct = Number(form.ladderStepPct);
  const multiple = Number(form.ladderMultiple);
  if (!Number.isFinite(stepPct) || stepPct <= 0 || stepPct > 50)
    throw new Error("Step size must be between 0 and 50 percent.");
  if (!Number.isFinite(multiple) || multiple < 1 || multiple > 5)
    throw new Error("Size multiple must be between 1 and 5.");
  amount(form.ladderStart, "First step price");
  amount(form.amount, "First step amount");
  const start = Number(form.ladderStart);
  const first = Number(form.amount);
  return Array.from({ length: count }, (_, i) => ({
    price: (start * (1 - stepPct / 100) ** i).toFixed(6),
    amount: (first * multiple ** i).toFixed(2),
  }));
}

function rulePlan(form: StrategyForm, symbols: string[]) {
  if (form.shape === "recurring") return recurringPlan(symbols, form.amount);
  if (form.shape === "rebalance") {
    // Equal weight. Anything else needs a per-asset control, and an equal-weight basket is both
    // the common case and the one a user can check at a glance.
    const target = Math.floor(10_000 / symbols.length);
    return rebalancePlan(symbols, String(target), form.amount);
  }
  if (form.shape === "ladder") return ladderPlan(symbols[0] as string, ladderRungs(form));
  if (form.shape === "discount") {
    const bps = integer(form.discountBps, 1, 2_000, "Discount");
    return discountPlan(symbols, String(bps), form.amount);
  }
  // Validated per symbol, so the error names the one that is wrong instead of failing on
  // whichever happens to be first.
  for (const symbol of symbols) amount(form.thresholds[symbol] ?? "", `${symbol} target price`);
  return levelsPlan(symbols, form.direction, form.thresholds, form.amount);
}

export function draftInput(form: StrategyForm, now = Date.now()) {
  const symbols = selection(form);
  if (form.authoring === "rule" && form.shape === "ladder" && symbols.length !== 1)
    throw new Error("A step ladder follows one stock at a time. Choose a single stock.");
  /**
   * A ladder's per-order cap is its LARGEST rung, not its first.
   *
   * `per_order` is enforced per order by the envelope, and a scale-in deliberately buys more
   * each step. Sizing the cap from the opening amount would let rung one through and refuse
   * every rung after it — the strategy would look armed, fire once, and quietly do nothing on
   * exactly the falls it was built for.
   */
  const perOrderAmount =
    form.authoring === "rule" && form.shape === "ladder"
      ? (ladderRungs(form).at(-1)?.amount ?? form.amount)
      : form.amount;
  const perOrder = amount(perOrderAmount, "Per-order limit");
  const total = amount(form.budget, "Total budget");
  const perDay = amount(form.dailyBudget || form.budget, "Daily budget");
  if (perOrder > perDay || perDay > total)
    throw new Error(
      "Keep the per-order limit within the daily budget, and the daily budget within the total.",
    );
  if (form.authoring === "text" && (!form.prompt.trim() || form.prompt.length > 4000))
    throw new Error("Describe your strategy in 1–4,000 characters.");
  return {
    name: name(form, symbols),
    assets: symbols,
    mode: form.mode,
    ...(form.authoring === "text"
      ? { prompt: form.prompt.trim() }
      : { plan: rulePlan(form, symbols) }),
    caps: {
      lifetime: form.budget,
      per_order: perOrderAmount,
      per_period: form.dailyBudget || form.budget,
      period_secs: 86400,
      max_orders_per_period: integer(form.maxOrders, 1, 10000, "Daily order limit"),
      // For a recurring plan the cadence IS the cooldown: the plan's condition is always true,
      // so this cap is the only thing deciding how often it buys.
      cooldown_secs:
        form.authoring === "rule" && form.shape === "recurring"
          ? integer(form.cadenceHours, 1, 8760, "Buy every") * 3600
          : integer(form.cooldownMinutes, 0, 525600, "Cooldown") * 60,
      expires_at: new Date(now + integer(form.days, 1, 365, "Duration") * 86400000).toISOString(),
      slippage_bps: integer(form.slippageBps, 1, 500, "Slippage limit"),
    },
  };
}
