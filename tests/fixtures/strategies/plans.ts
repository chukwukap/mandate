/**
 * Authored plans, exactly as they arrive from the compiler: plain JSON, unvalidated.
 *
 * Nothing here is passed through `validatePlan` at module load. The malformed fixtures must
 * reach the validator as raw input to produce the issue list a user is meant to act on, and
 * pre-validating the good ones would hide a schema change behind a fixture that no longer
 * describes what the product accepts.
 */

const feed = (uri: string) => ({ kind: "feed", feed: uri }) as const;
const constant = (value: string) => ({ kind: "const", value }) as const;
const parameter = (id: string) => ({ kind: "param", param: id }) as const;

const buy = (asset: number, value: string) =>
  ({ action: "order", asset, side: "buy", size: { unit: "quote", value } }) as const;

/** `oracle:AAPLc` below the authored entry price. One guard, driven by one feed. */
const belowEntry = {
  id: "below_entry",
  op: "lt",
  args: [feed("oracle:AAPLc"), parameter("entry")],
} as const;

const entryParam = { id: "entry", label: "Entry price (USDC)", value: "325" } as const;

/**
 * The plainest thing the product can express: buy 250 USDC of AAPLc the first time the
 * reference price crosses below $325, then stop.
 *
 * `holding` has no transitions on purpose. It is reachable, so validation accepts it, and it
 * is where the machine parks — the strategy is done, not broken.
 */
export const CONDITIONAL_BUY = {
  params: [entryParam],
  nodes: [belowEntry],
  machines: [
    {
      id: "entry_machine",
      scope: "portfolio",
      initial: "waiting",
      states: [
        {
          id: "waiting",
          transitions: [
            { when: "below_entry", fires: "on_edge", to: "holding", actions: [buy(0, "250")] },
          ],
        },
        { id: "holding", transitions: [] },
      ],
    },
  ],
};

/**
 * Two orders in one firing, against a period cap that only fits one.
 *
 * Both are inside the per-order cap when looked at alone. Only the second is refused, and only
 * because the first one's reservation is visible within the same tick — a budget that read the
 * persisted counters afresh for each action would admit both and then be unable to settle one.
 */
export const ENVELOPE_TRIPPER = {
  params: [entryParam],
  nodes: [belowEntry],
  machines: [
    {
      id: "entry_machine",
      scope: "portfolio",
      initial: "waiting",
      states: [
        {
          id: "waiting",
          transitions: [
            {
              when: "below_entry",
              fires: "on_edge",
              to: "holding",
              actions: [buy(0, "250"), buy(0, "250")],
            },
          ],
        },
        { id: "holding", transitions: [] },
      ],
    },
  ],
};

/**
 * A rule that must fire once per crossing, not once per tick.
 *
 * The state loops back to itself, so nothing but the edge memory stops it firing again. A
 * "buy below $325" guard stays true for hours; level-triggered evaluation would buy every
 * tick until the period cap was gone, which is the single most expensive way to be wrong here.
 */
export const EDGE_TRIGGERED = {
  params: [entryParam],
  nodes: [belowEntry],
  machines: [
    {
      id: "entry_machine",
      scope: "portfolio",
      initial: "watching",
      states: [
        {
          id: "watching",
          transitions: [
            { when: "below_entry", fires: "on_edge", to: "watching", actions: [buy(0, "50")] },
          ],
        },
      ],
    },
  ],
};

/**
 * The same rule written to repeat deliberately, capped at two firings per episode.
 *
 * This is the contrast that gives `EDGE_TRIGGERED` its meaning: repeated firing is a thing an
 * author can ask for, and when they do it carries a hard limit, and the limit resets when the
 * guard goes false so it bounds one episode rather than the strategy's life.
 */
export const LEVEL_TRIGGERED = {
  params: [entryParam],
  nodes: [belowEntry],
  machines: [
    {
      id: "entry_machine",
      scope: "portfolio",
      initial: "watching",
      states: [
        {
          id: "watching",
          transitions: [
            {
              when: "below_entry",
              fires: "while_true",
              max_repeats: 2,
              to: "watching",
              actions: [buy(0, "50")],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * A perfectly valid plan that orders asset index 1 — MSFTc, which has a live Chainlink
 * reference and no Aerodrome pool this system routes.
 *
 * Nothing about it is malformed, and that is the point: the strategy layer admits the order
 * and the venue is where it dies. A system that only refused untradable assets at authoring
 * time would have no answer when liquidity disappears after signing.
 */
export const UNTRADABLE_ASSET = {
  params: [],
  nodes: [{ id: "msft_cheap", op: "lt", args: [feed("oracle:MSFTc"), constant("500")] }],
  machines: [
    {
      id: "entry_machine",
      scope: "portfolio",
      initial: "waiting",
      states: [
        {
          id: "waiting",
          transitions: [
            { when: "msft_cheap", fires: "on_edge", to: "holding", actions: [buy(1, "250")] },
          ],
        },
        { id: "holding", transitions: [] },
      ],
    },
  ],
};

/**
 * Structurally well-formed, semantically broken in nine different ways at once.
 *
 * One issue per mistake, each addressed at the exact path that caused it, all reported in a
 * single pass. A validator that stopped at the first failure would make fixing this a
 * nine-round conversation, and every round costs the user another compile.
 */
export const MALFORMED_SEMANTICS = {
  params: [entryParam],
  nodes: [
    // A quantity, not a condition. Used as a guard below.
    { id: "price", op: "add", args: [feed("oracle:AAPLc"), constant("0")] },
    // `gt` takes two operands. One is not a comparison.
    { id: "half_compare", op: "gt", args: [parameter("entry")] },
    // TSLAc is a real B20 equity and is not in this strategy's signed allowlist, so no
    // observation for it will ever exist.
    { id: "ghost", op: "lt", args: [feed("oracle:TSLAc"), constant("1")] },
  ],
  machines: [
    {
      id: "entry_machine",
      // Position-scoped machines were never implemented. Running one as a portfolio machine
      // silently would execute a different strategy than the one described.
      scope: "position",
      initial: "start",
      states: [
        {
          id: "start",
          transitions: [
            {
              when: "price",
              fires: "on_edge",
              // on_edge already fires once per rising edge; a limit here would read as a cap
              // the author does not actually have.
              max_repeats: 5,
              to: "nowhere",
              actions: [
                buy(7, "10"),
                { action: "order", asset: 0, side: "sell", size: { unit: "quote", value: "10" } },
                { action: "set", var: "seen", value: "price" },
              ],
            },
          ],
        },
        { id: "orphan", transitions: [] },
      ],
    },
  ],
};

/**
 * Broken before semantics get a look in: a non-numeric parameter, an operator that does not
 * exist, and a negative order size.
 *
 * These are the mistakes a hand-edited or hallucinated plan actually makes, and each one has
 * to come back naming the field rather than as a nested validator dump.
 */
export const MALFORMED_SCHEMA = {
  params: [{ id: "entry", label: "Entry price (USDC)", value: "not-a-number" }],
  nodes: [{ id: "below", op: "beneath", args: [feed("oracle:AAPLc"), constant("325")] }],
  machines: [
    {
      id: "entry_machine",
      scope: "portfolio",
      initial: "waiting",
      states: [
        {
          id: "waiting",
          transitions: [
            {
              when: "below",
              to: "waiting",
              actions: [
                { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "-250" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};
