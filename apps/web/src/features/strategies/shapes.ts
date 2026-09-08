import type { StrategyForm } from "./authoring";

/**
 * The five things a strategy can be, written as what the user wants rather than what we build.
 *
 * The old chooser listed mechanisms — "A price for each", "Cheaper than the reference" — and a
 * tester asked how to build a martingale while looking directly at one. Three failures were
 * stacked there: the options described our implementation instead of their goal, they sat
 * mid-form so they read as a feature list rather than a decision, and the word people actually
 * search for appeared nowhere.
 *
 * So each entry carries three registers. `goal` is first-person, and it is what the user picks.
 * `also` is the industry term, so someone who arrived knowing the jargon finds it. `mechanism`
 * is what we actually do, kept because a person about to sign a spending authority deserves to
 * know it in our words rather than theirs.
 *
 * `caveat` is not marketing balance. It is the sentence that stops someone buying a strategy
 * that cannot do the thing its common name implies — most sharply for the ladder, which has a
 * martingale's entry and none of its exits.
 */
export type ShapeId = "levels" | "discount" | "recurring" | "ladder" | "rebalance";

export type Shape = {
  id: ShapeId;
  goal: string;
  also: string;
  mechanism: string;
  bestWhen: string;
  caveat?: string;
  /** Multi-asset shapes read naturally as a basket; a ladder addresses one stock by design. */
  single?: boolean;
};

export const SHAPES: readonly Shape[] = [
  {
    id: "levels",
    goal: "Buy it if the price drops to a level I pick",
    also: "Limit buy",
    mechanism: "Watches the Chainlink price and buys once when it crosses your level.",
    bestWhen: "You know the price you'd be happy to pay.",
  },
  {
    id: "recurring",
    goal: "Put the same amount in on a schedule",
    also: "DCA",
    mechanism: "Buys a fixed amount every interval, whatever the price is doing.",
    bestWhen: "You want to build a position over time without watching it.",
  },
  {
    id: "ladder",
    goal: "Buy more, and bigger, the further it falls",
    also: "Martingale-style scale-in",
    mechanism: "A series of steps down. Each step triggers lower and buys a larger amount.",
    bestWhen: "You want the position anyway and expect a dip to recover.",
    caveat:
      "This only buys. There is no take-profit and no stop-loss — it stops after the last step and holds.",
    single: true,
  },
  {
    id: "rebalance",
    goal: "Keep several stocks at an even weight",
    also: "Rebalancing",
    mechanism: "Tops up whichever holding has fallen behind its share of the basket.",
    bestWhen: "You want a spread rather than a single bet.",
    caveat: "It can only add to the laggards. It never sells the one that has run ahead.",
  },
  {
    id: "discount",
    goal: "Buy when it's cheaper here than the reference price",
    also: "Basis trade",
    mechanism: "Compares the Aerodrome pool against Chainlink and buys the gap.",
    bestWhen: "You want the onchain discount rather than a view on the company.",
  },
];

export const shapeById = (id: ShapeId) => SHAPES.find((s) => s.id === id) as Shape;

/**
 * Worked examples, loaded whole.
 *
 * Every platform researched leads with these — Coinrule's templates, Composer's Discover,
 * Pionex's presets — for the same reason: editing a filled-in example is a far smaller task than
 * producing one from an empty form, and it teaches the shape by showing it. The ladder is
 * deliberately among them, because "how do I make a martingale" should be answerable with one
 * click.
 *
 * Prices are left empty on purpose. They are the one value that must come from today's market
 * rather than from a constant written weeks ago, and the builder fills them from the live price.
 */
export type Starter = {
  id: string;
  title: string;
  summary: string;
  shape: ShapeId;
  symbols: string[];
  form: Partial<StrategyForm>;
};

export const STARTERS: readonly Starter[] = [
  {
    id: "weekly-nvda",
    title: "$50 into NVIDIA every week",
    summary: "The simplest thing that works. Same amount, same day, no decisions.",
    shape: "recurring",
    symbols: ["NVDAc"],
    form: { amount: "50", budget: "600", cadenceHours: "168", days: "90" },
  },
  {
    id: "apple-dip",
    title: "Buy Apple if it drops 5%",
    summary: "One level, one buy. Waits until the price you name.",
    shape: "levels",
    symbols: ["AAPLc"],
    form: { amount: "100", budget: "100", direction: "lt", days: "60" },
  },
  {
    id: "tesla-ladder",
    title: "Step into Tesla as it falls",
    summary: "Four steps, each 4% lower and 1.6× bigger. A martingale-style scale-in.",
    shape: "ladder",
    symbols: ["TSLAc"],
    form: {
      amount: "40",
      budget: "500",
      ladderStepPct: "4",
      ladderMultiple: "1.6",
      ladderRungs: "4",
      days: "90",
    },
  },
  {
    id: "big-seven",
    title: "An even spread of all seven",
    summary: "Keeps every name at roughly one seventh, topping up whatever lags.",
    shape: "rebalance",
    symbols: ["AAPLc", "GOOGLc", "METAc", "NVDAc", "MSFTc", "AMZNc", "TSLAc"],
    form: { amount: "25", budget: "700", days: "180" },
  },
];
