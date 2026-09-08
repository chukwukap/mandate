import { test } from "bun:test";
import { initialRuntime } from "../src/machines/runtime.js";
import { tick } from "../src/machines/tick.js";
import type { Envelope } from "../src/validation/schema.js";
import { validatePlan } from "../src/validation/semantics.js";

const assets = [
  {
    symbol: "AAPLc",
    token: "0x1111111111111111111111111111111111111111",
    feed: "0x2222222222222222222222222222222222222222",
    decimals: 8,
  },
] as const;
const buy = { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "50" } };

// 32 self-loop while_true rules in one state, all sharing the tautology guard.
const plan = {
  params: [],
  nodes: [
    {
      id: "always",
      op: "gt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "0" },
      ],
    },
  ],
  machines: [
    {
      id: "dca",
      scope: "portfolio",
      initial: "running",
      states: [
        {
          id: "running",
          transitions: Array.from({ length: 32 }, () => ({
            when: "always",
            fires: "while_true",
            max_repeats: 10000,
            to: "running",
            actions: [buy],
          })),
        },
      ],
    },
  ],
};

test("32-rule fall-through extends the runway", () => {
  const p = validatePlan(plan, assets as never);
  const DAY = 86_400_000;
  const env: Envelope = {
    version: "mandate/2",
    caps: {
      lifetime: "50000",
      per_order: "50",
      per_period: "100",
      period_secs: 86400,
      max_orders_per_period: 1,
      cooldown_secs: 0,
      expires_at: new Date(Date.now() + 400 * DAY).toISOString(),
      slippage_bps: 50,
    },
    assets: assets as never,
    quote: "0x3333333333333333333333333333333333333333",
    venue: "aerodrome",
  } as Envelope;
  const t0 = Date.now();
  let rt = initialRuntime(p, t0);
  const feeds = { "oracle:AAPLc": "230.5", "dex:AAPLc": "231.9" };
  const portfolio = {
    equity: "10000",
    positions: { "0x1111111111111111111111111111111111111111": "0" },
  };
  const TICK = 12_000,
    perDay = 1900;
  let buys = 0,
    n = 0;
  const dayBuys: number[] = [];
  let cur = 0;
  for (n = 0; n < 32 * 10000 + 5000; n++) {
    const day = Math.floor(n / perDay);
    if (day !== cur) {
      dayBuys.push(buys);
      cur = day;
      buys = 0;
    }
    const now = t0 + day * DAY + (n % perDay) * TICK;
    const r = tick(p, env, rt, feeds, portfolio, now);
    rt = r.state;
    buys += r.intents.length;
    if (r.intents.length > 1) {
      console.log("MULTI-BUY at tick", n);
      break;
    }
  }
  const total = rt.totalOrders;
  const days = Object.values(rt.machines.dca.repeats).reduce((a, b) => a + b, 0) / perDay;
  console.log("total admitted buys:", total, "days of coverage:", days.toFixed(1));
  console.log(
    "max buys in any single day:",
    Math.max(...dayBuys),
    "min:",
    Math.min(...dayBuys.slice(0, -1)),
  );
  console.log("sample repeats keys:", Object.keys(rt.machines.dca.repeats).length);
});
