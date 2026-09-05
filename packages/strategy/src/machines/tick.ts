import { Budget, rollPeriod } from "../enforcement/envelope.js";
import type { Portfolio } from "../enforcement/sizing.js";
import { evaluate } from "../evaluation/evaluator.js";
import { isDecimalString } from "../evaluation/money.js";
import type { Envelope, Plan } from "../validation/schema.js";
import type { Intent, Runtime } from "./runtime.js";
import { selectTransition } from "./transitions.js";

export const EXPIRED = "Strategy expired";

export type TickResult = {
  /** The runtime to persist. Always a fresh object; `previous` is never touched. */
  state: Runtime;
  intents: Intent[];
  refused: string[];
  notifications: string[];
};

/**
 * Evaluate one tick of a signed strategy.
 *
 * Pure with respect to its inputs: the caller's runtime, portfolio and feeds are
 * cloned or copied, so a thrown error or a refused order leaves them untouched and
 * the caller can retry against the same snapshot.
 *
 * Order of operations is deliberate and matches docs/architecture/worker.md:
 * expiry, then a single complete evaluation, then the period roll, then machines in
 * declaration order.
 */
export function tick(
  plan: Plan,
  envelope: Envelope,
  previous: Runtime,
  feeds: Record<string, string>,
  portfolio: Portfolio,
  now: number,
): TickResult {
  const state = structuredClone(previous);
  const result: TickResult = { state, intents: [], refused: [], notifications: [] };
  // A halt is terminal. Nothing below runs again, including the expiry check, so a
  // halted instance never rewrites its halt reason.
  if (state.halted) return result;

  // Expiry precedes evaluation: past `expires_at` the onchain permission is dead and
  // no observation could justify an order, so there is nothing to compute.
  if (now >= Date.parse(envelope.caps.expires_at)) {
    state.halted = true;
    result.refused.push(EXPIRED);
    return result;
  }

  // The counters are JSONB and nothing in the database constrains them. A non-decimal
  // `lifetime` makes `new Money(lifetime)` NaN, and every `NaN.gt(cap)` is false — the
  // lifetime cap would silently stop binding on a corrupted row. Two regex tests turn
  // that into a failed tick instead of an unbounded spend.
  if (!isDecimalString(state.lifetime) || !isDecimalString(state.periodSpent))
    throw new Error("Persisted spend counters are not decimal numbers");

  // One complete evaluation or none. `evaluate` throws on a missing or unusable feed
  // rather than substituting zero, so a broken observation skips the tick instead of
  // reading as "condition not met" — which is exactly when a stop-loss must not sleep.
  const values = evaluate(plan, feeds);

  rollPeriod(state, envelope.caps, now);
  const budget = new Budget(envelope, state, portfolio, now);

  for (const machine of plan.machines) {
    const memory = state.machines[machine.id];
    // The persisted runtime and the signed plan must describe the same machines. If
    // they do not, the row belongs to a different strategy; refusing the tick keeps
    // the instance armed and visible instead of quietly running a subset of its rules.
    if (!memory) throw new Error(`Missing persisted machine: ${machine.id}`);
    const current = machine.states.find((s) => s.id === memory.current);
    if (!current) throw new Error(`Invalid persisted state: ${memory.current}`);

    const chosen = selectTransition(current, memory, values);
    if (!chosen) continue;
    memory.current = chosen.transition.to;

    const fireKey = `${machine.id}/${chosen.key}`;
    // Captured once, before the actions run: several orders in one firing share that
    // firing's cooldown, so a rule that buys two assets is not half-blocked by itself.
    const lastFire = state.lastFires[fireKey] ?? Number.NEGATIVE_INFINITY;

    for (const action of chosen.transition.actions) {
      if (action.action === "halt") {
        state.halted = true;
        result.notifications.push(action.reason);
        break;
      }
      if (action.action === "notify") {
        result.notifications.push(action.message);
        continue;
      }
      if (action.action === "set") {
        // Validation rejects `set` before a plan can be signed, and admission
        // re-validates before ticking, so this is unreachable on a verified plan.
        // Recorded rather than silently skipped so that if a plan ever did reach here
        // the evaluation row shows why the rule did nothing.
        result.refused.push(`Unsupported action: set ${action.var}`);
        continue;
      }
      const decision = budget.admit(action, lastFire);
      if ("refusal" in decision) {
        result.refused.push(decision.refusal);
        continue;
      }
      // Only an admitted order starts a cooldown. A notify-only rule is free to fire
      // on every rising edge; the cooldown exists to space out spending, not speech.
      state.lastFires[fireKey] = now;
      result.intents.push({
        asset: action.asset,
        side: action.side,
        amount: decision.size.amount,
        fireKey,
      });
    }
    if (state.halted) break;
  }

  // A halt suppresses every intent from this evaluation, including orders admitted
  // before the halting action ran (docs/architecture/worker.md). Their budget stays
  // reserved: reservations are one-way, so a halting tick can consume cap for orders
  // that are never sent. That under-spends, which is the only safe direction.
  if (state.halted) result.intents = [];
  return result;
}
