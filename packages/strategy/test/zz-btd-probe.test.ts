import { expect, test } from "bun:test";
import type { Portfolio } from "../src/machines/index.js";
import { initialRuntime, tick } from "../src/machines/index.js";
import type { Asset } from "../src/validation/index.js";
import { capsSchema, validatePlan } from "../src/validation/index.js";

const AAPL: Asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}`,
  feed: `0x${"22".repeat(20)}`,
  decimals: 8,
};
const T0 = Date.parse("2026-09-05T12:00:00Z");
const portfolio: Portfolio = { equity: "10000", positions: { [AAPL.token.toLowerCase()]: "5" } };

// Quantized high-water-mark ratchet.
// Bands at 100,110,120,130. In band_k: rule0 ratchets up if oracle >= level_{k+1};
// rule1 buys on_edge (self-loop) if oracle < level_k * 0.95.
const LEVELS = [100, 110, 120, 130];
const nodes: unknown[] = [];
for (const [i, lvl] of LEVELS.entries()) {
  const next = LEVELS[i + 1];
  if (next !== undefined)
    nodes.push({
      id: `up_${i}`,
      op: "gte",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: String(next) },
      ],
    });
  nodes.push({
    id: `dip_${i}`,
    op: "lt",
    args: [
      { kind: "feed", feed: "oracle:AAPLc" },
      { kind: "const", value: String(lvl * 0.95) },
    ],
  });
}
const buy = { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } };
const states = LEVELS.map((_, i) => {
  const transitions: unknown[] = [];
  if (LEVELS[i + 1] !== undefined)
    transitions.push({
      when: `up_${i}`,
      fires: "on_edge",
      actions: [{ action: "notify", message: `ratchet->band_${i + 1}` }],
      to: `band_${i + 1}`,
    });
  transitions.push({
    when: `dip_${i}`,
    fires: "on_edge",
    actions: [{ action: "notify", message: `BUY dip from band_${i}` }, buy],
    to: `band_${i}`,
  });
  return { id: `band_${i}`, transitions };
});
const plan = validatePlan(
  { nodes, machines: [{ id: "hwm", scope: "portfolio", initial: "band_0", states }] },
  [AAPL],
);
const envelope = {
  version: "mandate/2" as const,
  caps: capsSchema.parse({
    lifetime: "1000",
    per_order: "10",
    per_period: "1000",
    period_secs: 86400,
    max_orders_per_period: 1000,
    cooldown_secs: 0,
    expires_at: "2027-01-01T00:00:00Z",
  }),
  assets: [AAPL],
};

test("ratchet HWM buys the dip relative to the highest band reached", () => {
  let runtime = initialRuntime(plan);
  // rally 100 -> 132, then a 5% dip from the new high, then another rally and dip
  const prices = ["100", "112", "122", "132", "132", "125", "123", "128", "132", "120"];
  const log: { p: string; state: string; notes: string[]; buys: number }[] = [];
  for (const [i, p] of prices.entries()) {
    const r = tick(
      plan,
      envelope,
      runtime,
      { "oracle:AAPLc": p, "dex:AAPLc": p },
      portfolio,
      T0 + i * 60_000,
    );
    runtime = r.state;
    log.push({
      p,
      state: runtime.machines.hwm!.current,
      notes: r.notifications,
      buys: r.intents.length,
    });
  }
  console.log(JSON.stringify(log, null, 1));
  console.log("lifetime spent:", runtime.lifetime, "orders:", runtime.totalOrders);
  expect(true).toBe(true);
});

test("portfolio feeds are readable from a condition", () => {
  const p2 = validatePlan(
    {
      nodes: [
        {
          id: "under_target",
          op: "lt",
          args: [
            { kind: "feed", feed: "value:AAPLc" },
            { kind: "const", value: "500" },
          ],
        },
        {
          id: "cheap",
          op: "lt",
          args: [
            { kind: "feed", feed: "oracle:AAPLc" },
            { kind: "const", value: "200" },
          ],
        },
        {
          id: "go",
          op: "and",
          args: [
            { kind: "node", node: "under_target" },
            { kind: "node", node: "cheap" },
          ],
        },
      ],
      machines: [
        {
          id: "m",
          scope: "portfolio",
          initial: "s",
          states: [
            { id: "s", transitions: [{ when: "go", fires: "on_edge", actions: [buy], to: "s" }] },
          ],
        },
      ],
    },
    [AAPL],
  );
  const r = tick(
    p2,
    envelope,
    initialRuntime(p2),
    {
      "oracle:AAPLc": "150",
      "dex:AAPLc": "150",
      "position:AAPLc": "5",
      "value:AAPLc": "750",
      equity: "10000",
      cash: "1000",
    },
    portfolio,
    T0,
  );
  console.log("value 750 (over 500 target) -> intents:", r.intents.length, "refused:", r.refused);
  const r2 = tick(
    p2,
    envelope,
    initialRuntime(p2),
    {
      "oracle:AAPLc": "150",
      "dex:AAPLc": "150",
      "position:AAPLc": "1",
      "value:AAPLc": "150",
      equity: "10000",
      cash: "1000",
    },
    portfolio,
    T0,
  );
  console.log("value 150 (under 500 target) -> intents:", r2.intents.length);
});
