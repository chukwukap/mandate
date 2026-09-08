import type { StrategyForm } from "./authoring";
import { ladderRungs } from "./authoring";

/**
 * What a strategy would do, computed from today's actual numbers.
 *
 * A FORWARD PROJECTION, never a backtest. The engine has no price history and neither does this
 * — every line below comes from the current oracle price, the user's cash, and the caps they
 * typed. Saying "this would have made X" would be inventing data we do not have, and every
 * platform that shows a backtest has history to draw it from. We do not.
 *
 * The ladder rung table was the only place the builder did arithmetic on a user's behalf, and it
 * was also the least confusing shape to configure. Generalising it is the single change the
 * research agreed on most.
 */

export type Projection = {
  /** One sentence describing the rule, with the user's own numbers substituted in. */
  sentence: string;
  /** Would this fire right now, at today's prices? The most useful single fact. */
  today: { firing: boolean; detail: string } | null;
  /** Rows of concrete arithmetic: orders affordable, total committed, per-asset triggers. */
  facts: { label: string; value: string }[];
  /** Things that are true and unwelcome. Never hidden, never softened. */
  warnings: string[];
};

const money = (value: number) =>
  value >= 1000 ? `$${Math.round(value).toLocaleString()}` : `$${value.toFixed(2)}`;

const names = (symbols: string[]) => {
  const short = symbols.map((s) => s.replace("c", ""));
  if (short.length === 1) return short[0] as string;
  if (short.length === 2) return short.join(" and ");
  return `${short.slice(0, -1).join(", ")} and ${short.at(-1)}`;
};

/**
 * A number, or nothing.
 *
 * The empty-string guard is the whole point: `Number("")` is 0, not NaN, so an absent price
 * silently became $0 — and against $0 every "falls below" rule reads as already met. The panel
 * would have told a user their strategy was about to buy at a moment when we had no price for
 * it at all.
 */
const num = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Whole days, rounded down, because "expires in 30.4 days" is not something anyone says. */
const expiryText = (days: string) => {
  const count = num(days);
  if (!count) return "";
  const when = new Date(Date.now() + count * 86_400_000);
  return when.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

export function project(
  form: StrategyForm,
  price: (symbol: string) => string | undefined,
  cash: string | null,
): Projection | null {
  if (form.authoring !== "rule" || form.symbols.length === 0) return null;
  const amount = num(form.amount);
  const budget = num(form.budget);
  const facts: { label: string; value: string }[] = [];
  const warnings: string[] = [];
  const who = names(form.symbols);
  const expires = expiryText(form.days);

  // Affordability is checked against CASH, never equity: stock cannot be spent, and a budget the
  // wallet cannot cover produces orders that fail at settlement rather than rules that misfire.
  const available = num(cash ?? undefined);
  if (budget && available !== undefined && budget > available)
    warnings.push(
      `Your budget is ${money(budget)} but your wallet holds ${money(available)} USDC. It will buy until the cash runs out and then wait.`,
    );

  if (budget && amount && amount > 0) {
    const orders = Math.floor(budget / amount);
    if (orders < 1)
      warnings.push("Each buy is larger than the total budget, so nothing can be bought.");
    else facts.push({ label: "Buys this budget affords", value: `${orders}` });
  }
  if (expires) facts.push({ label: "Stops on", value: expires });

  if (form.shape === "recurring") {
    const hours = num(form.cadenceHours);
    const every = !hours
      ? ""
      : hours === 24
        ? "every day"
        : hours === 168
          ? "every week"
          : hours % 24 === 0
            ? `every ${hours / 24} days`
            : `every ${hours} hours`;
    if (hours && amount && budget) {
      const orders = Math.floor(budget / amount);
      const days = Math.round((orders * hours) / 24);
      facts.push({ label: "Budget lasts about", value: `${days} days at this pace` });
      const runFor = num(form.days);
      if (runFor && days > runFor)
        warnings.push(
          `At this pace the budget outlasts the strategy — it stops on ${expires} with money unspent.`,
        );
    }
    return {
      sentence: `Buy ${amount ? money(amount) : "…"} of ${who} ${every}, whatever the price, up to ${budget ? money(budget) : "…"} in total.`,
      // Nothing is being waited for: a recurring rule is always willing, so the honest answer is
      // that it buys on its next check rather than "if" some condition holds.
      today: { firing: true, detail: "This buys on its next check, then waits for the cadence." },
      facts,
      warnings,
    };
  }

  if (form.shape === "ladder") {
    const only = form.symbols[0];
    if (!only) return null;
    let rungs: { price: string; amount: string }[];
    try {
      rungs = ladderRungs(form);
    } catch {
      return null;
    }
    const total = rungs.reduce((sum, r) => sum + Number(r.amount), 0);
    const deepest = Number(rungs.at(-1)?.amount ?? 0);
    const spot = num(price(only));
    facts.push({ label: "Steps", value: `${rungs.length}` });
    facts.push({ label: "Total if every step fills", value: money(total) });
    // The per-order cap is signed at the LARGEST rung, which is not the number the user typed
    // into "amount per buy" and is the one surprise this shape reliably produces.
    facts.push({ label: "Largest single buy", value: money(deepest) });
    if (budget && total > budget)
      warnings.push(
        `Every step filling costs ${money(total)}, more than the ${money(budget)} budget. The last steps would be refused.`,
      );
    if (available !== undefined && total > available)
      warnings.push(
        `Every step filling costs ${money(total)}, more than the ${money(available)} USDC you hold.`,
      );
    warnings.push(
      "Nothing sells this back. It stops after the last step and holds what it bought.",
    );
    const first = Number(rungs[0]?.price ?? 0);
    const deepestPrice = Number(rungs.at(-1)?.price ?? 0);
    /**
     * Every step already crossed.
     *
     * A ladder set above today's price is not a ladder — all of its rungs are true at once, and
     * the machine walks the whole chain on consecutive ticks, spending the entire commitment in
     * minutes at a single price. That is the exact failure a scale-in exists to avoid, and it is
     * easy to reach by accident: the first-step field is prefilled with today's price, so any
     * upward drift puts spot underneath the whole thing.
     */
    if (spot !== undefined && spot < deepestPrice)
      warnings.push(
        `Every step is above ${money(spot)}, today's price — all ${rungs.length} would trigger at once and spend ${money(total)} straight away. Set the first step below the current price to step in gradually.`,
      );
    return {
      sentence: `Buy ${who} in ${rungs.length} steps as it falls, starting under ${money(first)} and buying more at each step, up to ${money(total)}.`,
      today:
        spot === undefined
          ? null
          : spot < first
            ? { firing: true, detail: `${who} is ${money(spot)}, already below the first step.` }
            : {
                firing: false,
                detail: `${who} is ${money(spot)}. The first step needs ${money(first)}, ${(((first - spot) / spot) * 100).toFixed(1)}% away.`,
              },
      facts,
      warnings,
    };
  }

  if (form.shape === "rebalance") {
    const share = (100 / form.symbols.length).toFixed(0);
    warnings.push(
      "This can only buy, so it corrects by topping up whichever has fallen behind — it never sells the one that has run ahead.",
    );
    return {
      sentence: `Keep ${who} at about ${share}% each by buying ${amount ? money(amount) : "…"} of whichever has fallen behind, up to ${budget ? money(budget) : "…"} in total.`,
      today: null,
      facts,
      warnings,
    };
  }

  if (form.shape === "discount") {
    const bps = num(form.discountBps);
    return {
      sentence: `Buy ${amount ? money(amount) : "…"} of ${who} whenever its pool price is ${bps ?? "…"} bps below the Chainlink reference, up to ${budget ? money(budget) : "…"} in total.`,
      today: null,
      facts,
      warnings,
    };
  }

  // levels
  const triggers = form.symbols
    .map((s) => ({ symbol: s, target: num(form.thresholds[s]), spot: num(price(s)) }))
    .filter((t) => t.target !== undefined);
  const firingNow = triggers.filter((t) =>
    t.spot === undefined || t.target === undefined
      ? false
      : form.direction === "lt"
        ? t.spot < t.target
        : t.spot > t.target,
  );
  for (const t of triggers)
    if (t.spot !== undefined)
      facts.push({
        label: t.symbol.replace("c", ""),
        value: `${money(t.target as number)} · ${((((t.target as number) - t.spot) / t.spot) * 100).toFixed(1)}% from today`,
      });
  const word = form.direction === "lt" ? "falls below" : "rises above";
  return {
    sentence: `Buy ${amount ? money(amount) : "…"} of ${who} whenever it ${word} the price you set, up to ${budget ? money(budget) : "…"} in total.`,
    today:
      // No threshold set, or no price to judge one against. "Nothing meets this yet" would be an
      // assertion about a comparison we cannot actually make, so the panel stays quiet instead.
      triggers.length === 0 || triggers.every((t) => t.spot === undefined)
        ? null
        : firingNow.length > 0
          ? {
              firing: true,
              detail: `${names(firingNow.map((t) => t.symbol))} already ${firingNow.length === 1 ? "meets" : "meet"} this — it would buy on the next check.`,
            }
          : { firing: false, detail: "Nothing meets this yet. It will wait and watch." },
    facts,
    warnings,
  };
}
