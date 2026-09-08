/**
 * Plans the structured builder can produce.
 *
 * Every shape here was validated against the real `validatePlan` with the seven-asset catalogue
 * before it was written into the app, and each carries a design decision that came out of
 * running the engine rather than reading it. Those are recorded next to the code that depends on
 * them, because they are not guessable from the schema.
 *
 * See docs/product/strategies.md for the full set and the measurements behind them.
 */

/** An `order` action's `asset` is an index into the envelope's `assets` array, in the order sent. */
type Order = {
  action: "order";
  asset: number;
  side: "buy";
  size: { unit: "quote"; value: string };
};

type Transition = {
  when: string;
  fires: "on_edge" | "while_true";
  max_repeats?: number;
  to: string;
  actions: (Order | { action: "notify"; message: string })[];
};

export type Plan = {
  nodes: {
    id: string;
    op: string;
    args: (
      | { kind: "feed"; feed: string }
      | { kind: "node"; node: string }
      | { kind: "const"; value: string }
    )[];
  }[];
  machines: {
    id: string;
    scope: "portfolio";
    initial: string;
    states: { id: string; transitions: Transition[] }[];
  }[];
};

/**
 * One machine per asset, never one machine with several transitions.
 *
 * At most ONE transition fires per machine per tick. Putting seven assets' rules in a single
 * machine would mean that when the market gaps and all seven conditions become true at once, the
 * strategy buys one of them per cadence interval — six of the seven filling minutes later at
 * prices nobody chose. Separate machines evaluate independently in the same tick.
 *
 * Machine ids are derived from the symbol rather than the index, so a plan stays readable on the
 * review card the user signs.
 */
function machine(symbol: string, when: string, actions: Transition["actions"]) {
  return {
    id: `entry_${symbol}`,
    scope: "portfolio" as const,
    initial: "watching",
    states: [
      {
        id: "watching",
        // A self-loop, not a terminal state. `on_edge` memory is keyed by state and only the
        // CURRENT state's transitions are refreshed, so a machine that moves to `filled` and
        // back carries a stale `true` and misses its next crossing entirely. Staying put keeps
        // the edge honest; the envelope's caps are what bound how often this can fire.
        transitions: [{ when, fires: "on_edge" as const, to: "watching", actions }],
      },
    ],
  };
}

const buy = (asset: number, value: string): Order => ({
  action: "order",
  asset,
  side: "buy",
  size: { unit: "quote", value },
});

/**
 * A price level per asset: "buy $50 of Apple under $200, and $50 of NVIDIA under $150".
 *
 * The shape people mean when they pick several tokens. Each asset gets its own threshold and its
 * own machine, so they fire independently and one triggering does not delay another.
 */
export function levelsPlan(
  symbols: string[],
  direction: "lt" | "gt",
  thresholds: Record<string, string>,
  amount: string,
): Plan {
  return {
    nodes: symbols.map((symbol) => ({
      id: `target_${symbol}`,
      op: direction,
      args: [
        { kind: "feed" as const, feed: `oracle:${symbol}` },
        { kind: "const" as const, value: thresholds[symbol] ?? "0" },
      ],
    })),
    machines: symbols.map((symbol, index) =>
      machine(symbol, `target_${symbol}`, [buy(index, amount)]),
    ),
  };
}

/**
 * Buy any selected asset while the Aerodrome ask sits a chosen margin below the Chainlink
 * reference — the one signal this system has that a broker screen does not.
 *
 * Two things make the arithmetic here non-obvious, and both are measured rather than assumed:
 *
 * `dex:` is NOT a mid price. It is the effective price of a $10 buy, so it already carries the
 * pool fee and that order's impact — it is an ask. The ratio therefore sits ABOVE 1 in normal
 * conditions (measured: +8 to +45 bps across the catalogue), which means a reading at parity is
 * already a discount to the true mid, and a threshold of 0.998 is stricter than it looks.
 *
 * The lower bound is not decoration. A pool 10% under its reference is not a bargain, it is a
 * broken or empty pool — the same failure that had one AAPLc pool quoting $37,861 a share. The
 * band buys a dislocation and declines a catastrophe.
 */
export function discountPlan(symbols: string[], discountBps: string, amount: string): Plan {
  const ratio = (1 - Number(discountBps) / 10_000).toFixed(6);
  // 500 bps is the same deviation limit the market catalogue uses to judge a quote unusable.
  const floor = (1 - 500 / 10_000).toFixed(6);
  return {
    nodes: symbols.flatMap((symbol) => [
      {
        id: `basis_${symbol}`,
        op: "safe_div",
        args: [
          { kind: "feed" as const, feed: `dex:${symbol}` },
          { kind: "feed" as const, feed: `oracle:${symbol}` },
          // safe_div is ternary: the third argument is what to use when the DIVISOR is zero.
          // A zero oracle means Chainlink returned nothing usable, which is not a buying
          // opportunity — and 0 is precisely the value the sanity floor below rejects, so a dead
          // reference lands in the same branch as a broken pool instead of reading as a 100%
          // discount and firing on every asset at once.
          { kind: "const" as const, value: "0" },
        ],
      },
      {
        id: `cheap_${symbol}`,
        op: "lte",
        args: [
          { kind: "node" as const, node: `basis_${symbol}` },
          { kind: "const" as const, value: ratio },
        ],
      },
      {
        id: `sane_${symbol}`,
        op: "gte",
        args: [
          { kind: "node" as const, node: `basis_${symbol}` },
          { kind: "const" as const, value: floor },
        ],
      },
      {
        id: `enter_${symbol}`,
        op: "and",
        args: [
          { kind: "node" as const, node: `cheap_${symbol}` },
          { kind: "node" as const, node: `sane_${symbol}` },
        ],
      },
    ]),
    machines: symbols.map((symbol, index) =>
      machine(symbol, `enter_${symbol}`, [
        buy(index, amount),
        {
          action: "notify",
          message: `${symbol}: bought the pool at a discount to the reference.`,
        },
      ]),
    ),
  };
}

/** Kept for the single-asset path, which is still the common case. */
export function makePlan(
  symbol: string,
  direction: "lt" | "gt",
  threshold: string,
  amount: string,
): Plan {
  return levelsPlan([symbol], direction, { [symbol]: threshold }, amount);
}

/**
 * A trivially true condition, so the only thing pacing a rule is the envelope.
 *
 * Prices are non-negative, so this holds on every tick the strategy is evaluated at all. It
 * exists because "buy on a schedule" is not a statement about price, and the engine has no clock
 * to say it with directly.
 */
function always(symbol: string) {
  return {
    id: "always",
    op: "gte",
    args: [
      { kind: "feed" as const, feed: `oracle:${symbol}` },
      { kind: "const" as const, value: "0" },
    ],
  };
}

/**
 * Recurring buys — dollar-cost averaging.
 *
 * There is no clock in the engine, and for a long time that read as "DCA is impossible". It is
 * not: the signed envelope already carries `cooldown_secs`, and an admitted order stamps
 * `lastFires[machine/transition]`, so a rule that is always true fires exactly as often as the
 * cooldown allows and no more. Simulated over 1,440 ten-minute ticks with an 86,400s cooldown:
 * ten fills, each 24 hours apart to the minute.
 *
 * The cadence therefore lives in `caps.cooldown_secs`, not in the plan — the caller must set it,
 * and the review card shows it as the cooldown the user is signing.
 *
 * One cost worth knowing: every tick between fills records a refusal, because the rule wants to
 * fire and the cooldown says no. That is a lot of rows for a slow schedule, and it is the honest
 * shape of the mechanism rather than a bug.
 */
export function recurringPlan(symbols: string[], amount: string): Plan {
  return {
    nodes: [always(symbols[0] ?? "AAPLc")],
    machines: symbols.map((symbol, index) => ({
      id: `buy_${symbol}`,
      scope: "portfolio" as const,
      initial: "buying",
      states: [
        {
          id: "buying",
          transitions: [
            {
              when: "always",
              // `while_true`, not `on_edge`: an edge fires once and never again, which is a
              // single purchase. Repeating is the whole point here, and the cap is what stops it.
              fires: "while_true" as const,
              max_repeats: 10_000,
              to: "buying",
              actions: [buy(index, amount)],
            },
          ],
        },
      ],
    })),
  };
}

/**
 * An escalating dip ladder: buy more, at a larger size, each time the price falls another step.
 *
 * This is the accumulation half of what trading bots call a martingale or "DCA with safety
 * orders", and it is deliberately NOT named after either. A martingale bot is defined as much by
 * its exit — take-profit on the average entry, then reset and cycle — as by its scaling, and the
 * exit needs to sell. Selling is not something this system can do automatically: a Coinbase
 * spend permission authorises one token, and that token is USDC. Shipping the scale-in under a
 * name that implies the exit exists would sell someone an accumulator with no brakes.
 *
 * So what this is: a bounded way to buy progressively more into a fall, for someone who wants
 * the position anyway and wants a hard ceiling on the total. The ceiling is the envelope's
 * `lifetime` cap, not anything in the plan.
 *
 * Each rung is a state, which is how the machine remembers how deep it already is without any
 * variables — the engine has none. Rungs only ever advance, so a recovery does not re-arm them.
 */
export function ladderPlan(symbol: string, rungs: { price: string; amount: string }[]): Plan {
  return {
    nodes: rungs.map((rung, index) => ({
      id: `step_${index}`,
      op: "lt",
      args: [
        { kind: "feed" as const, feed: `oracle:${symbol}` },
        { kind: "const" as const, value: rung.price },
      ],
    })),
    machines: [
      {
        id: `ladder_${symbol}`,
        scope: "portfolio" as const,
        initial: "rung0",
        states: [
          ...rungs.map((rung, index) => ({
            id: `rung${index}`,
            transitions: [
              {
                when: `step_${index}`,
                fires: "on_edge" as const,
                to: index + 1 < rungs.length ? `rung${index + 1}` : "spent",
                actions: [buy(0, rung.amount)],
              },
            ],
          })),
          // Terminal on purpose. The ladder has spent what it was authorised to spend, and
          // nothing here can sell it back.
          { id: "spent", transitions: [] },
        ],
      },
    ],
  };
}

/**
 * Target-weight rebalancing, buy side.
 *
 * Tops up whichever holdings have fallen below their share of the portfolio, using the
 * `value:` and `equity` feeds. Simulated from a 100%-Apple book over 25 rounds: it converges
 * toward the targets and stops when cash runs out.
 *
 * The ceiling is real and worth stating on the review card: with no sell authority this corrects
 * drift only by DILUTION — it buys the laggards, it can never trim the winner. A book that has
 * run far past its target stays past it until fresh USDC arrives, and once the cash is gone the
 * strategy is simply idle.
 *
 * `cash` gates every rule rather than `equity`, because equity counts stock and stock cannot be
 * spent; sizing against equity alone produces orders a wallet cannot settle.
 */
export function rebalancePlan(symbols: string[], targetBps: string, amount: string): Plan {
  const target = (Number(targetBps) / 10_000).toFixed(6);
  return {
    nodes: symbols.flatMap((symbol) => [
      {
        id: `weight_${symbol}`,
        op: "safe_div",
        args: [
          { kind: "feed" as const, feed: `value:${symbol}` },
          { kind: "feed" as const, feed: "equity" },
          // A zero equity is an empty account, not an underweight one. Zero keeps the weight
          // below target and would buy; the fallback of 1 reads as "fully weighted" and holds.
          { kind: "const" as const, value: "1" },
        ],
      },
      {
        id: `under_${symbol}`,
        op: "lt",
        args: [
          { kind: "node" as const, node: `weight_${symbol}` },
          { kind: "const" as const, value: target },
        ],
      },
      {
        id: `funded_${symbol}`,
        op: "gte",
        args: [
          { kind: "feed" as const, feed: "cash" },
          { kind: "const" as const, value: amount },
        ],
      },
      {
        id: `topup_${symbol}`,
        op: "and",
        args: [
          { kind: "node" as const, node: `under_${symbol}` },
          { kind: "node" as const, node: `funded_${symbol}` },
        ],
      },
    ]),
    machines: symbols.map((symbol, index) => ({
      id: `weight_${symbol}`,
      scope: "portfolio" as const,
      initial: "watching",
      states: [
        {
          id: "watching",
          transitions: [
            {
              when: `topup_${symbol}`,
              fires: "while_true" as const,
              max_repeats: 10_000,
              to: "watching",
              actions: [buy(index, amount)],
            },
          ],
        },
      ],
    })),
  };
}
