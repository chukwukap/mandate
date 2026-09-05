import { z } from "zod";
import { decimalString, type Plan } from "../validation/schema.js";

/**
 * Per-machine memory that survives between ticks.
 *
 * `edges` and `repeats` are what make a rule edge-triggered rather than level
 * triggered: without the previous truth value persisted, a condition that stays true
 * would fire on every tick, and a "buy when the price drops below $200" rule would
 * buy once a minute for as long as the price stayed there.
 *
 * Both are keyed `<stateId>/<transitionIndex>`, so editing a plan's transitions would
 * re-point the memory. Plans are immutable once signed, so that cannot happen to a
 * running instance.
 */
export type MachineState = {
  current: string;
  /** Kept for shape compatibility with persisted rows; `set` actions are rejected in validation. */
  vars: Record<string, string>;
  edges: Record<string, boolean>;
  repeats: Record<string, number>;
};

export type Runtime = {
  machines: Record<string, MachineState>;
  /** USDC reserved over the strategy's whole life, decimal string. */
  lifetime: string;
  /** USDC reserved in the current period, decimal string. */
  periodSpent: string;
  /** Epoch ms of the current period's boundary. Aligned, never reset to "now". */
  periodStart: number;
  orders: number;
  totalOrders: number;
  /** Epoch ms of each rule's last firing, keyed `<machineId>/<stateId>/<index>`. */
  lastFires: Record<string, number>;
  halted: boolean;
};

export type Intent = {
  asset: number;
  side: "buy" | "sell";
  /** Decimal amount, already floored to the input token's real decimals. */
  amount: string;
  fireKey: string;
};

const machineStateSchema = z.strictObject({
  current: z.string().min(1).max(64),
  vars: z.record(z.string(), z.string()),
  edges: z.record(z.string(), z.boolean()),
  repeats: z.record(z.string(), z.int().nonnegative()),
});

/**
 * Shape of a persisted runtime row.
 *
 * The runtime lives in JSONB, so nothing in the database enforces its shape. A row
 * written by an older release, or hand-edited, would otherwise be ticked on directly:
 * a missing `lifetime` reads as undefined and `new Money(undefined)` is NaN, and every
 * cap comparison against NaN is false — the lifetime cap would silently stop binding.
 * Parsing first turns that into a refused tick.
 */
export const runtimeSchema = z.strictObject({
  machines: z.record(z.string(), machineStateSchema),
  lifetime: decimalString,
  periodSpent: decimalString,
  periodStart: z.number().int(),
  orders: z.int().nonnegative(),
  totalOrders: z.int().nonnegative(),
  lastFires: z.record(z.string(), z.number()),
  halted: z.boolean(),
});

/**
 * Fresh runtime for a newly armed instance.
 *
 * `now` becomes the period origin, and every later boundary is a whole number of
 * periods from it (see rollPeriod). It is deliberately not the onchain permission's
 * `start`, which is chosen later at prepare time.
 */
export function initialRuntime(plan: Plan, now: number): Runtime {
  return {
    machines: Object.fromEntries(
      plan.machines.map((m) => [
        m.id,
        { current: m.initial, vars: {}, edges: {}, repeats: {} } satisfies MachineState,
      ]),
    ),
    lifetime: "0",
    periodSpent: "0",
    periodStart: now,
    orders: 0,
    totalOrders: 0,
    lastFires: {},
    halted: false,
  };
}
