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
          transitions: [
            {
              when: "always",
              fires: "while_true",
              max_repeats: 10000,
              to: "running",
              actions: [
                { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "50" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("tautology + while_true + caps == scheduled DCA", () => {
  const p = validatePlan(plan, assets as never);
  console.log("VALIDATES: yes");

  const DAY = 86_400_000;
  const env: Envelope = {
    version: "mandate/2",
    caps: {
      lifetime: "5000",
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

  // 12s cadence, RTH-only: 1900 ticks/day. Simulate 3 days compressed.
  const TICK = 12_000;
  const perDay = 1900;
  const buysByDay: number[] = [];
  for (let day = 0; day < 3; day++) {
    let buys = 0;
    for (let i = 0; i < perDay; i++) {
      const now = t0 + day * DAY + i * TICK;
      const r = tick(p, env, rt, feeds, portfolio, now);
      rt = r.state;
      buys += r.intents.length;
    }
    buysByDay.push(buys);
  }
  console.log("BUYS PER DAY:", buysByDay);
  console.log(
    "repeats after 3 days:",
    rt.machines.dca.repeats,
    "totalOrders:",
    rt.totalOrders,
    "lifetime:",
    rt.lifetime,
  );

  // Now run until repeats exhaust
  let n = 5700;
  let extraBuys = 0;
  while ((rt.machines.dca.repeats["running/0"] ?? 0) < 10000 && n < 40000) {
    const now = t0 + Math.floor(n / perDay) * DAY + (n % perDay) * TICK;
    const r = tick(p, env, rt, feeds, portfolio, now);
    rt = r.state;
    extraBuys += r.intents.length;
    n++;
  }
  console.log(
    "EXHAUSTED at tick",
    n,
    "=> trading days:",
    (n / perDay).toFixed(2),
    "total buys:",
    3 + extraBuys,
  );
  // one more tick after exhaustion
  const r = tick(p, env, rt, feeds, portfolio, t0 + 100 * DAY);
  console.log(
    "AFTER EXHAUSTION -> intents:",
    r.intents.length,
    "refused:",
    r.refused,
    "notifications:",
    r.notifications,
  );
});
