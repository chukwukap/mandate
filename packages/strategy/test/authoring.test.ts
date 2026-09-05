import { expect, test } from "bun:test";
import { capsSchema, digest, type Envelope, review, units, validatePlan } from "../src/index.js";

const asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}` as `0x${string}`,
  feed: `0x${"22".repeat(20)}` as `0x${string}`,
  decimals: 8,
};
const input = {
  nodes: [
    {
      id: "below",
      op: "lt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "200" },
      ],
    },
  ],
  machines: [
    {
      id: "m",
      scope: "portfolio",
      initial: "watch",
      states: [
        {
          id: "watch",
          transitions: [
            {
              when: "below",
              to: "watch",
              actions: [{ action: "notify", message: "Price condition met" }],
            },
          ],
        },
      ],
    },
  ],
};
const caps = {
  lifetime: "100",
  per_order: "10",
  per_period: "20",
  period_secs: 86400,
  max_orders_per_period: 2,
  cooldown_secs: 60,
  expires_at: "2027-01-01T00:00:00Z",
};
test("canonical commitments ignore object key order, but bind meaningful changes", () => {
  expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  expect(digest({ a: "10" })).not.toBe(digest({ a: "100" }));
});
test("review is deterministic and includes asset identity and enforcement boundaries", () => {
  const plan = validatePlan(input, [asset]);
  const envelope: Envelope = {
    version: "mandate/2",
    caps: capsSchema.parse(caps),
    assets: [asset],
    quote: asset.token,
    venue: "aerodrome",
  };
  const a = review(plan, envelope);
  expect(a).toEqual(review(plan, envelope));
  expect(a.render_text).toContain(asset.token);
  expect(a.render_text).toContain("Mandate's server");
  expect(a.render_text).toContain("Price condition met");
});
test("unsupported feeds and cycles are rejected before persistence", () => {
  const invalid = structuredClone(input);
  const feed = invalid.nodes[0]?.args[0];
  if (!feed) throw new Error("Missing fixture feed");
  feed.feed = "oracle:UNKNOWN";
  expect(() => validatePlan(invalid, [asset])).toThrow("Unavailable feed");
  expect(() =>
    validatePlan(
      { ...input, nodes: [{ id: "below", op: "not", args: [{ kind: "node", node: "below" }] }] },
      [asset],
    ),
  ).toThrow("forward node");
});
test("caps preserve six-decimal USDC limits and enforce ordering", () => {
  expect(() => capsSchema.parse({ ...caps, per_order: "21" })).toThrow();
  expect(() => capsSchema.parse({ ...caps, per_order: "0.0000001" })).toThrow();
  expect(units("9007199254740993.123456", 6)).toBe(9007199254740993123456n);
});
