import type { Hex } from "@mandate/contracts";
import { z } from "zod";
import { DECIMAL_PATTERN, Money, units } from "../evaluation/money.js";
import { OPERATOR_IDS } from "../evaluation/operators.js";

export const decimalString = z.string().regex(DECIMAL_PATTERN);
const positive = decimalString.refine((v) => new Money(v).gt(0), "Must be positive");
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const hexAddress = z.custom<Hex>(
  (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v),
  "Expected a 20-byte address",
);

const arg = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("node"), node: id }),
  z.strictObject({ kind: z.literal("param"), param: id }),
  z.strictObject({ kind: z.literal("feed"), feed: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal("const"), value: decimalString }),
]);
const size = z.discriminatedUnion("unit", [
  z.strictObject({ unit: z.literal("quote"), value: positive }),
  z.strictObject({ unit: z.literal("base"), value: positive }),
  z.strictObject({ unit: z.literal("pct_equity"), bps: z.int().min(1).max(10_000) }),
  z.strictObject({ unit: z.literal("pct_position"), bps: z.int().min(1).max(10_000) }),
]);
export const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("order"),
    asset: z.int().nonnegative(),
    side: z.enum(["buy", "sell"]),
    size,
  }),
  z.strictObject({ action: z.literal("set"), var: id, value: id }),
  z.strictObject({ action: z.literal("notify"), message: z.string().min(1).max(500) }),
  z.strictObject({ action: z.literal("halt"), reason: z.string().min(1).max(500) }),
]);
const transition = z.strictObject({
  when: id,
  fires: z.enum(["on_edge", "while_true"]).default("on_edge"),
  max_repeats: z.int().min(1).max(10_000).optional(),
  actions: z.array(actionSchema).min(1).max(16),
  to: id,
});
export const planSchema = z.strictObject({
  params: z
    .array(z.strictObject({ id, label: z.string().max(120), value: decimalString }))
    .max(64)
    .default([]),
  nodes: z
    .array(
      z.strictObject({
        id,
        // Driven by the operator table so a new operator cannot be accepted by the
        // schema and then be unknown to the evaluator on a signed strategy.
        op: z.enum(OPERATOR_IDS),
        args: z.array(arg).min(1).max(32),
      }),
    )
    .min(1)
    .max(256),
  machines: z
    .array(
      z.strictObject({
        id,
        scope: z.enum(["portfolio", "position"]),
        initial: id,
        states: z
          .array(z.strictObject({ id, transitions: z.array(transition).max(32) }))
          .min(1)
          .max(32),
      }),
    )
    .min(1)
    .max(16),
});
export const capsSchema = z
  .strictObject({
    lifetime: positive,
    per_order: positive,
    per_period: positive,
    period_secs: z.int().min(1).max(31_536_000),
    max_orders_per_period: z.int().min(1).max(10_000),
    cooldown_secs: z.int().min(0).max(31_536_000),
    expires_at: z.iso.datetime({ offset: true }),
    slippage_bps: z.int().min(1).max(500).default(50),
  })
  .superRefine((c, ctx) => {
    if (new Money(c.per_order).gt(c.per_period) || new Money(c.per_period).gt(c.lifetime)) {
      ctx.addIssue({ code: "custom", message: "Require per-order ≤ per-period ≤ lifetime" });
    }
    for (const field of ["lifetime", "per_order", "per_period"] as const) {
      if (new Money(c[field]).decimalPlaces() > 6)
        ctx.addIssue({ code: "custom", path: [field], message: "USDC has six decimal places" });
      // uint160 is the width of SpendPermissionManager's `allowance`. A cap above it
      // could never be expressed onchain, so it must be refused before signing.
      //
      // Unreachable as written: `decimal` bounds the integer part to 40 digits, so
      // the largest cap expressible is under 1e40, which is 1e46 USDC units against
      // a 2^160 ≈ 1.46e48 ceiling. Kept as a backstop because it is the widened
      // regex, not this line, that would be the mistake — and this catches it.
      if (units(c[field], 6) >= 2n ** 160n)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Exceeds onchain allowance capacity",
        });
    }
  });
export const assetSchema = z.strictObject({
  symbol: z.string().min(1).max(24),
  token: hexAddress,
  feed: hexAddress,
  decimals: z.int().min(0).max(36),
});
/**
 * The whole signed authority, not just its caps. Admission re-reads a stored
 * envelope out of JSONB before ticking on it; parsing it here means a row that was
 * written by an older shape is refused instead of silently sizing an order against
 * a field that is no longer there.
 */
export const envelopeSchema = z.strictObject({
  version: z.literal("mandate/2"),
  caps: capsSchema,
  assets: z.array(assetSchema).min(1).max(20),
  quote: hexAddress,
  venue: z.literal("aerodrome"),
});

export type Plan = z.infer<typeof planSchema>;
export type Caps = z.infer<typeof capsSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type Machine = Plan["machines"][number];
export type State = Machine["states"][number];
export type Transition = State["transitions"][number];
export type OrderAction = Extract<Action, { action: "order" }>;
export type OrderSize = OrderAction["size"];
export type Side = OrderAction["side"];
