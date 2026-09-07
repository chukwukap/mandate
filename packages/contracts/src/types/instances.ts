import type { InstanceStatus } from "./primitives.js";

/**
 * The state a running strategy can be in, and what each state means to the worker.
 *
 * `instances.status` is one of four values, constrained by the `instance_status_valid` CHECK
 * and by `statusSchema`. The union alone does not say which of them the scheduler will pick
 * up, which of them a user can still act on, or which of them are over — and every consumer
 * that needs to know has been re-deriving it. This module answers those questions once.
 */

/** What a user may ask this API to do to a running strategy. */
export type LifecycleAction = "arm" | "pause" | "kill";

export type TerminalInstanceStatus = Extract<InstanceStatus, "halted" | "ended">;

/**
 * The statuses no transition can leave.
 *
 * "halted" and "ended" are both over but they are not the same event, and they must not be
 * collapsed. Nothing writes "ended" for any reason other than a lapsed envelope, so "ended"
 * *is* expiry and tells a user their authority ran out; "halted" carries its own halt reason
 * — "Drawdown limit reached", "Stopped by user" — which is the only record of why a strategy
 * actually stopped, and reporting it back as expiry would erase that.
 */
export const TERMINAL_INSTANCE_STATUSES: readonly TerminalInstanceStatus[] = Object.freeze([
  "halted",
  "ended",
]);

/**
 * Takes a `string`, not an `InstanceStatus`.
 *
 * The callers that need this hold a value drizzle types as `string` — `InstanceRow.status` is
 * a `text` column — and casting it to the union to call a narrower signature is exactly the
 * step that stops the compiler from helping. An unrecognised status is treated as non-terminal,
 * which is what `Repository.transition` already does with one; the CHECK means it cannot occur,
 * and agreeing with the repository beats inventing a fifth answer.
 */
export function isTerminalInstanceStatus(status: string): status is TerminalInstanceStatus {
  return (TERMINAL_INSTANCE_STATUSES as readonly string[]).includes(status);
}

/**
 * What the system will do next with an instance in this state.
 *
 * - `scheduled` the worker's `due()` query selects on `status = 'armed'`, so only these tick.
 * - `idle`      live and owned, but not scheduled. Re-arming is a normal 200, not a conflict.
 * - `terminal`  over. Continuing requires a newly signed draft; there is no path back.
 */
export type InstanceDisposition = "scheduled" | "idle" | "terminal";

export function instanceDisposition(status: InstanceStatus): InstanceDisposition {
  switch (status) {
    case "armed":
      return "scheduled";
    case "paused":
      return "idle";
    case "halted":
    case "ended":
      return "terminal";
  }
}

/**
 * The halt reason written when a signed envelope's expiry has passed.
 *
 * Two writers produce this string for one event — the API materialises expiry under the row
 * lock before it decides a lifecycle transition, and the worker's admission gate writes it on
 * the tick that crosses the deadline. They must be byte-identical: a history panel that shows
 * one strategy as "expired" and its sibling as "Strategy expired" is two bugs, and a support
 * query for either one silently misses the other.
 */
export const EXPIRY_HALT_REASON = "Strategy expired";

/**
 * Every value `evaluations.outcome` can hold — one per tick, whether or not anything traded.
 *
 * This is the refusal ledger's vocabulary, and it exists because a user needs to see that the
 * system considered acting and chose not to. Each value is a deliberate decision:
 *
 * - `evaluated`   conditions were checked; no rule fired. The overwhelmingly common case.
 * - `halted`      a rule fired `halt`. The strategy stopped itself.
 * - `expired`     the signed envelope's `expires_at` passed. The instance is now "ended".
 * - `execution-disabled`
 *                 the executor is running observation-only. An auto instance is not funded.
 * - `eligibility-renewal-required`
 *                 the jurisdiction attestation lapsed. The instance is paused, not halted:
 *                 the user can renew and re-arm.
 * - `observation-or-authority-unavailable`
 *                 prices, the permission or the venue could not be verified, so the tick was
 *                 skipped. Nothing is inferred from an absent observation.
 * - `observation-expired`
 *                 the observation was too old by the time the tick committed and was
 *                 discarded rather than acted on.
 * - `invalid-commitment`
 *                 the stored strategy failed commitment verification: a malformed envelope, an
 *                 asset outside the catalogue, an artifact or render hash that did not reproduce,
 *                 or a signature that did not verify. NOT transient and NOT a market condition: the row
 *                 reached the database by some path other than the API accepting a signature,
 *                 so the instance is left where it is and the event is worth an operator's
 *                 attention. Observed for real when a strategy was inserted directly into the
 *                 database with a forged signature — the tick refused it, which is the boundary
 *                 working, but it was filed under a name that reads like an RPC outage.
 *
 * Only the first three describe the strategy itself; the rest are the system declining to act
 * on the user's behalf, which is why none of them halts an instance except `halted` itself.
 */
export const EVALUATION_OUTCOMES = Object.freeze([
  "evaluated",
  "halted",
  "expired",
  "execution-disabled",
  "eligibility-renewal-required",
  "observation-or-authority-unavailable",
  "observation-expired",
  "invalid-commitment",
] as const);

export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];

export function isEvaluationOutcome(value: string): value is EvaluationOutcome {
  return (EVALUATION_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The tick outcomes that leave an instance able to trade again without the user doing anything.
 *
 * `expired` and `halted` are absent because they are terminal. `eligibility-renewal-required`
 * is absent because it needs the user to renew — it pauses rather than halts, but the next
 * tick will not happen on its own.
 */
export function isTransientEvaluationOutcome(outcome: EvaluationOutcome): boolean {
  return (
    outcome === "execution-disabled" ||
    outcome === "observation-or-authority-unavailable" ||
    outcome === "observation-expired"
  );
}
