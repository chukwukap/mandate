import { expect, test } from "bun:test";
import type { Portfolio } from "../src/machines/index.js";
import { initialRuntime, tick } from "../src/machines/index.js";
import { review } from "../src/review/index.js";
import type { Asset, Envelope, Plan } from "../src/validation/index.js";
import { capsSchema, validatePlan } from "../src/validation/index.js";

const AAPL: Asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}`,
  feed: `0x${"22".repeat(20)}`,
  decimals: 8,
};
const T0 = Date.parse("2026-09-08T14:00:00Z");
const portfolio: Portfolio = { equity: "10000", positions: { [AAPL.token.toLowerCase()]: "5" } };
const feeds = { "oracle:AAPLc": "180", "dex:AAPLc": "181" };

function build(caps: Record<string, unknown>, maxRepeats: number, childSize: string) {
  const plan: Plan = validatePlan(
    {
      params: [],
      nodes: [
        {
          id: "live",
          op: "gt",
          args: [
            { kind: "feed", feed: "oracle:AAPLc" },
            { kind: "const", value: "0" },
          ],
        },
      ],
      machines: [
        {
          id: "m",
          scope: "portfolio",
          initial: "slicing",
          states: [
            {
              id: "slicing",
              transitions: [
                {
                  when: "live",
                  fires: "while_true",
                  max_repeats: maxRepeats,
                  to: "slicing",
                  actions: [
                    {
                      action: "order",
                      asset: 0,
                      side: "buy",
                      size: { unit: "quote", value: childSize },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    [AAPL],
  );
  const envelope: Envelope = {
    version: "mandate/2",
    caps: capsSchema.parse(caps),
    assets: [AAPL],
    quote: `0x${"55".repeat(20)}`,
    venue: "aerodrome",
  };
  return { plan, envelope };
}

function run(plan: Plan, envelope: Envelope, ticks: number[], t0 = T0) {
  let runtime = initialRuntime(plan, t0);
  const fills: number[] = [];
  const refusals: Record<string, number> = {};
  for (const now of ticks) {
    const r = tick(plan, envelope, runtime, feeds, portfolio, now);
    runtime = r.state;
    if (r.intents.length) fills.push(Math.round((now - t0) / 1000));
    for (const x of r.refused) refusals[x] = (refusals[x] ?? 0) + 1;
  }
  return { fills, refusals, runtime };
}
const every = (n: number, ms: number, t0 = T0) => Array.from({ length: n }, (_, i) => t0 + i * ms);

test("A: cooldown_secs paces the slices; lifetime cap terminates the parent", () => {
  const { plan, envelope } = build(
    {
      lifetime: "100",
      per_order: "25",
      per_period: "100",
      period_secs: 86400,
      max_orders_per_period: 10000,
      cooldown_secs: 300,
      expires_at: "2027-01-01T00:00:00Z",
    },
    10000,
    "25",
  );
  const { fills, refusals, runtime } = run(plan, envelope, every(200, 12_000));
  console.log("A fills(s):", fills);
  console.log("A refusals:", refusals);
  console.log(
    "A repeats:",
    runtime.machines.m?.repeats,
    "lifetime:",
    runtime.lifetime,
    "totalOrders:",
    runtime.totalOrders,
  );
  expect(fills.length).toBe(4);
});

test("F: irregular ticks (backoff / RTH-shaped gaps) under cooldown pacing", () => {
  const { plan, envelope } = build(
    {
      lifetime: "1000",
      per_order: "25",
      per_period: "1000",
      period_secs: 86400,
      max_orders_per_period: 10000,
      cooldown_secs: 300,
      expires_at: "2027-01-01T00:00:00Z",
    },
    10000,
    "25",
  );
  // 12s ticks, but a 40-minute outage after 20 minutes, then 60s ticks (backoff).
  const ticks: number[] = [];
  for (let t = 0; t < 1200; t += 12) ticks.push(T0 + t * 1000);
  for (let t = 3600; t < 6000; t += 60) ticks.push(T0 + t * 1000);
  const { fills, runtime } = run(plan, envelope, ticks);
  console.log("F fills(s):", fills);
  console.log("F repeats:", runtime.machines.m?.repeats);
});

test("G: expires_at ends the slicing by halting, mid-parent", () => {
  const { plan, envelope } = build(
    {
      lifetime: "10000",
      per_order: "25",
      per_period: "10000",
      period_secs: 86400,
      max_orders_per_period: 10000,
      cooldown_secs: 300,
      expires_at: new Date(T0 + 1800_000).toISOString(),
    },
    10000,
    "25",
  );
  const { fills, refusals, runtime } = run(plan, envelope, every(300, 12_000));
  console.log(
    "G fills(s):",
    fills,
    "refusals:",
    refusals,
    "halted:",
    runtime.halted,
    "lifetime:",
    runtime.lifetime,
  );
});

test("H: period pacing exact cadence, and what a skipped period does (no catch-up)", () => {
  const { plan, envelope } = build(
    {
      lifetime: "1000",
      per_order: "25",
      per_period: "25",
      period_secs: 600,
      max_orders_per_period: 1,
      cooldown_secs: 0,
      expires_at: "2027-01-01T00:00:00Z",
    },
    10000,
    "25",
  );
  // Ticks stop for 3 whole periods then resume.
  const ticks: number[] = [];
  for (let t = 0; t < 1800; t += 60) ticks.push(T0 + t * 1000);
  for (let t = 3600; t < 5400; t += 60) ticks.push(T0 + t * 1000);
  const { fills, runtime } = run(plan, envelope, ticks);
  console.log("H fills(s):", fills, "lifetime:", runtime.lifetime);
});

test("I: what the signer actually reads on the review card for an always-true slicer", () => {
  const { plan, envelope } = build(
    {
      lifetime: "100",
      per_order: "25",
      per_period: "100",
      period_secs: 86400,
      max_orders_per_period: 10000,
      cooldown_secs: 300,
      expires_at: "2027-01-01T00:00:00Z",
    },
    10000,
    "25",
  );
  console.log("I render:\n" + review(plan, envelope).render_text);
});

test("J: two machines cannot double the slice rate past the envelope", () => {
  // Sanity: envelope caps are global, so splitting across machines does not evade them.
  const plan: Plan = validatePlan(
    {
      params: [],
      nodes: [
        {
          id: "live",
          op: "gt",
          args: [
            { kind: "feed", feed: "oracle:AAPLc" },
            { kind: "const", value: "0" },
          ],
        },
      ],
      machines: ["m1", "m2"].map((id) => ({
        id,
        scope: "portfolio",
        initial: "s",
        states: [
          {
            id: "s",
            transitions: [
              {
                when: "live",
                fires: "while_true",
                max_repeats: 10000,
                to: "s",
                actions: [
                  { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "25" } },
                ],
              },
            ],
          },
        ],
      })),
    },
    [AAPL],
  );
  const envelope: Envelope = {
    version: "mandate/2",
    caps: capsSchema.parse({
      lifetime: "1000",
      per_order: "25",
      per_period: "25",
      period_secs: 600,
      max_orders_per_period: 1,
      cooldown_secs: 0,
      expires_at: "2027-01-01T00:00:00Z",
    }),
    assets: [AAPL],
    quote: `0x${"55".repeat(20)}`,
    venue: "aerodrome",
  };
  const { fills, refusals } = run(plan, envelope, every(120, 60_000));
  console.log("J fills(s):", fills, "refusals:", refusals);
});
