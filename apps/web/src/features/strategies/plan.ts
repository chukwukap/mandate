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
  fires: "on_edge";
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
