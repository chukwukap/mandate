import { expect, test } from "bun:test";
import { capsSchema, type Envelope, initialRuntime, tick, validatePlan } from "@mandate/strategy";

const asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}` as const,
  feed: `0x${"22".repeat(20)}` as const,
  decimals: 8,
};
function fixture(side: "buy" | "sell" = "buy") {
  const action = {
    action: "order",
    asset: 0,
    side,
    size: { unit: side === "buy" ? "quote" : "base", value: "10" },
  };
  const plan = validatePlan(
    {
      nodes: [
        {
          id: "yes",
          op: "lt",
          args: [
            { kind: "const", value: "1" },
            { kind: "const", value: "2" },
          ],
        },
      ],
      machines: [
        {
          id: "m",
          scope: "portfolio",
          initial: "s",
          states: [
            {
              id: "s",
              transitions: [
                {
                  when: "yes",
                  fires: "while_true",
                  max_repeats: 10,
                  to: "s",
                  actions: [action, action],
                },
              ],
            },
          ],
        },
      ],
    },
    [asset],
  );
  const envelope: Envelope = {
    version: "mandate/2",
    quote: asset.token,
    assets: [asset],
    venue: "aerodrome",
    caps: capsSchema.parse({
      lifetime: "30",
      per_order: "10",
      per_period: "20",
      period_secs: 120,
      max_orders_per_period: 2,
      cooldown_secs: 60,
      expires_at: "2027-01-01T00:00:00Z",
    }),
  };
  return { plan, envelope };
}
const portfolio = { equity: "100", positions: { [asset.token.toLowerCase()]: "15" } };
test("one firing can admit multiple actions; cooldown applies to the next firing", () => {
  const { plan, envelope } = fixture();
  const now = Date.parse("2026-09-05T12:00:00Z");
  const first = tick(plan, envelope, initialRuntime(plan, now), {}, portfolio, now);
  expect(first.intents).toHaveLength(2);
  expect(first.state.lifetime).toBe("20");
  const second = tick(plan, envelope, first.state, {}, portfolio, now + 1000);
  expect(second.intents).toHaveLength(0);
  const renewed = tick(plan, envelope, second.state, {}, portfolio, now + 120000);
  expect(renewed.intents).toHaveLength(1);
  expect(renewed.state.lifetime).toBe("30");
  expect(first.state.lifetime).toBe("20"); // pure transition, no input mutation
});
test("multiple sells cannot reserve the same wallet balance twice", () => {
  const { plan, envelope } = fixture("sell");
  const now = Date.now();
  const result = tick(plan, envelope, initialRuntime(plan, now), {}, portfolio, now);
  expect(result.intents).toHaveLength(1);
  expect(result.refused).toContain("Insufficient stock balance");
});
test("expired strategies produce no orders and halt persistently", () => {
  const { plan, envelope } = fixture();
  const now = Date.parse("2027-01-01T00:00:00Z");
  const result = tick(plan, envelope, initialRuntime(plan, now - 1000), {}, portfolio, now);
  expect(result.state.halted).toBe(true);
  expect(result.intents).toHaveLength(0);
});
