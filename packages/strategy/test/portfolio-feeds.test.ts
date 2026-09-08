import { describe, expect, test } from "bun:test";
import type { Portfolio } from "../src/machines/index.js";
import { initialRuntime, tick } from "../src/machines/index.js";
import type { Asset, Envelope } from "../src/validation/index.js";
import { availableFeeds, capsSchema, validatePlan } from "../src/validation/index.js";

const AAPL: Asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}`,
  feed: `0x${"22".repeat(20)}`,
  decimals: 8,
};
const NVDA: Asset = {
  symbol: "NVDAc",
  token: `0x${"33".repeat(20)}`,
  feed: `0x${"44".repeat(20)}`,
  decimals: 8,
};

const caps = capsSchema.parse({
  lifetime: "10000",
  per_order: "50",
  per_period: "10000",
  period_secs: 86_400,
  max_orders_per_period: 1000,
  cooldown_secs: 0,
  expires_at: "2027-01-01T00:00:00Z",
  slippage_bps: 50,
});
const envelope: Envelope = {
  version: "mandate/2",
  caps,
  assets: [AAPL, NVDA],
  quote: `0x${"55".repeat(20)}`,
  venue: "aerodrome",
};

/** Buy `symbol` while it is under `target` of equity and there is cash to do it with. */
function rebalancePlan(target: string) {
  return validatePlan(
    {
      nodes: [AAPL, NVDA].flatMap((a) => [
        {
          id: `w_${a.symbol}`,
          op: "safe_div",
          args: [
            { kind: "feed", feed: `value:${a.symbol}` },
            { kind: "feed", feed: "equity" },
            { kind: "const", value: "0" },
          ],
        },
        {
          id: `under_${a.symbol}`,
          op: "lt",
          args: [
            { kind: "node", node: `w_${a.symbol}` },
            { kind: "const", value: target },
          ],
        },
        {
          id: `afford_${a.symbol}`,
          op: "gte",
          args: [
            { kind: "feed", feed: "cash" },
            { kind: "const", value: "50" },
          ],
        },
        {
          id: `top_${a.symbol}`,
          op: "and",
          args: [
            { kind: "node", node: `under_${a.symbol}` },
            { kind: "node", node: `afford_${a.symbol}` },
          ],
        },
      ]),
      machines: [AAPL, NVDA].map((a, index) => ({
        id: `rebal_${a.symbol}`,
        scope: "portfolio",
        initial: "watching",
        states: [
          {
            id: "watching",
            transitions: [
              {
                when: `top_${a.symbol}`,
                to: "watching",
                actions: [
                  {
                    action: "order",
                    asset: index,
                    side: "buy",
                    size: { unit: "quote", value: "50" },
                  },
                ],
              },
            ],
          },
        ],
      })),
    },
    [AAPL, NVDA],
  );
}

function snapshot(cash: number, aapl: number, nvda: number) {
  const value = { AAPLc: aapl * 300, NVDAc: nvda * 200 };
  const equity = cash + value.AAPLc + value.NVDAc;
  const feeds: Record<string, string> = {
    cash: String(cash),
    equity: String(equity),
    "oracle:AAPLc": "300",
    "dex:AAPLc": "300",
    "oracle:NVDAc": "200",
    "dex:NVDAc": "200",
    "position:AAPLc": String(aapl),
    "position:NVDAc": String(nvda),
    "value:AAPLc": String(value.AAPLc),
    "value:NVDAc": String(value.NVDAc),
  };
  const portfolio: Portfolio = {
    equity: String(equity),
    positions: {
      [AAPL.token.toLowerCase()]: String(aapl),
      [NVDA.token.toLowerCase()]: String(nvda),
    },
  };
  return { feeds, portfolio, equity };
}

describe("portfolio feeds", () => {
  test("the vocabulary carries holdings, not only prices", () => {
    const feeds = availableFeeds([AAPL, NVDA]);
    for (const uri of [
      "oracle:AAPLc",
      "dex:AAPLc",
      "position:AAPLc",
      "value:AAPLc",
      "position:NVDAc",
      "value:NVDAc",
      "equity",
      "cash",
    ])
      expect(feeds.has(uri)).toBe(true);
    // Still a closed vocabulary: an unlisted asset cannot be smuggled in through a feed name.
    expect(feeds.has("position:TSLAc")).toBe(false);
  });

  test("a target-weight rule fires only for the underweight asset", () => {
    const plan = rebalancePlan("0.5");
    const { feeds, portfolio } = snapshot(500, 3, 0); // all Apple, no NVIDIA
    const result = tick(plan, envelope, initialRuntime(plan, 0), feeds, portfolio, 1);
    // Apple is 900/1400 = 64% and must not be topped up; NVIDIA is 0% and must be.
    expect(result.intents.map((i) => i.asset)).toEqual([1]);
  });

  test("it stops buying once the target weight is reached", () => {
    const plan = rebalancePlan("0.5");
    // 300 and 200 against 900 equity: 33% and 22%, both genuinely under half. (An earlier
    // version of this used 300/400 of 800, where NVIDIA sits at exactly 0.5 — `lt` is strict, so
    // it correctly did not fire and the test was wrong, not the engine.)
    const { feeds, portfolio } = snapshot(400, 1, 1);
    const first = tick(plan, envelope, initialRuntime(plan, 0), feeds, portfolio, 1);
    expect(first.intents.map((i) => i.asset)).toEqual([0, 1]);
    // Now NVIDIA is comfortably over half: its rule must go quiet rather than keep buying.
    const rich = snapshot(100, 1, 5);
    const second = tick(plan, envelope, initialRuntime(plan, 0), rich.feeds, rich.portfolio, 1);
    expect(second.intents.map((i) => i.asset)).toEqual([0]);
  });

  test("equity counts stock but cash gates the order, because stock cannot be spent", () => {
    const plan = rebalancePlan("0.9");
    // Large equity, no spendable cash. Without the `cash` guard this would order into a wallet
    // that cannot settle it — the exact failure the review card warns about for pct_equity.
    const { feeds, portfolio } = snapshot(0, 10, 10);
    expect(tick(plan, envelope, initialRuntime(plan, 0), feeds, portfolio, 1).intents).toEqual([]);
  });

  test("a missing portfolio observation fails the tick rather than reading as zero", () => {
    const plan = rebalancePlan("0.5");
    const { feeds, portfolio } = snapshot(500, 3, 0);
    delete feeds.equity;
    // A zero equity would make every weight 0/0 and look like "everything is underweight",
    // which is the most expensive possible way to be wrong.
    expect(() => tick(plan, envelope, initialRuntime(plan, 0), feeds, portfolio, 1)).toThrow();
  });
});
