import { Problem } from "@mandate/contracts";

/**
 * Machine-stable identifiers for every reason the funding gate can turn an order away.
 *
 * These are not the tick-time refusal strings in `@mandate/strategy`'s enforcement
 * module ("Per-order cap exceeded" and friends). Those explain why an order was never
 * created; these explain why an order that already exists, and that the user can see in
 * their history, will not be funded. Conflating the two vocabularies would make
 * `evaluations.refused` ambiguous about whether anything was ever admitted.
 *
 * The ids are stable strings rather than an enum so they survive a database round trip
 * and can be grepped in logs. Adding one is additive; renaming one is a breaking change
 * to anything that alerts on them.
 */
export type LimitId =
  // Envelope caps, re-checked against persisted counters at funding time.
  | "cap.per_order"
  | "cap.per_period"
  | "cap.lifetime"
  | "cap.orders_per_period"
  | "cap.cooldown"
  | "cap.expired"
  // Spend permission: the onchain authority the caps are supposed to mirror.
  | "permission.missing"
  | "permission.inactive"
  | "permission.hash_mismatch"
  | "permission.account_mismatch"
  | "permission.spender_mismatch"
  | "permission.token_mismatch"
  | "permission.period_mismatch"
  | "permission.allowance_mismatch"
  | "permission.outlives_strategy"
  | "permission.not_started"
  | "permission.expired"
  | "permission.horizon"
  | "permission.signature_invalid"
  | "permission.period_allowance"
  // Asset, pair and size.
  | "asset.not_in_catalogue"
  | "asset.not_in_envelope"
  | "asset.pair_mismatch"
  | "asset.amount_mismatch"
  | "size.zero"
  | "size.dust"
  | "size.uint160"
  // Route quality.
  | "quote.unavailable"
  | "quote.outside_reference_band"
  | "quote.expired"
  | "quote.zero_output"
  | "reference.unavailable"
  // Time, eligibility and operating posture.
  | "session.closed"
  | "session.observation_stale"
  | "eligibility.country"
  | "eligibility.expired"
  | "instance.not_armed"
  | "instance.not_auto"
  | "execution.disabled"
  | "order.stale"
  | "condition.no_longer_holds";

/**
 * One refused check.
 *
 * `observed` and `bound` are always both present and always rendered as strings, because
 * the failure mode this whole module exists to prevent is a refusal that names a limit
 * without saying what the limit was or how far past it the order sat. "Per-order cap
 * exceeded" tells a user nothing they can act on; "cap.per_order: 25.000000 USDC exceeds
 * the 10.000000 USDC per-order cap" tells them to lower the size or re-sign.
 *
 * `unit` carries the scale so nothing downstream has to guess whether a number is USDC
 * minor units, whole shares, seconds or basis points.
 */
export type Refusal = {
  readonly limit: LimitId;
  readonly title: string;
  readonly observed: string;
  readonly bound: string;
  readonly unit: string;
};

export function refuse(
  limit: LimitId,
  title: string,
  observed: string | number | bigint,
  bound: string | number | bigint,
  unit: string,
): Refusal {
  return {
    limit,
    title,
    observed: String(observed),
    bound: String(bound),
    unit,
  };
}

/** One refusal as a single readable sentence: what was hit, what was seen, what was allowed. */
export function describeRefusal(refusal: Refusal): string {
  return `${refusal.limit}: ${refusal.title} (observed ${refusal.observed} ${refusal.unit}, limit ${refusal.bound} ${refusal.unit})`;
}

/**
 * The string persisted to `evaluations.refused` and `executions.reason`.
 *
 * Joined with "; " to match what `tick()` already writes into the same columns, so an
 * operator reading a history does not have to switch formats halfway down the page. The
 * result is truncated at 900 characters: `executions.reason` is unbounded `text`, but a
 * refusal list long enough to matter has already told the reader everything useful, and
 * an unbounded string built from unbounded input is how a log line becomes a payload.
 */
export function describeRefusals(refusals: readonly Refusal[]): string {
  if (refusals.length === 0) return "";
  const joined = refusals.map(describeRefusal).join("; ");
  return joined.length <= 900 ? joined : `${joined.slice(0, 897)}...`;
}

/**
 * The HTTP surface for a refusal.
 *
 * 409, not 400 or 422: nothing about the request is malformed. The order is well formed
 * and the authority is real; it is the current state of the caps, the permission or the
 * market that conflicts with running it, and that state can change without the caller
 * changing anything. The first refusal names the code so clients can branch on the
 * specific limit; the detail lists all of them so a user fixing one does not discover
 * the next on the following attempt.
 */
export function refusalProblem(refusals: readonly Refusal[]): Problem {
  const first = refusals[0];
  if (!first)
    return new Problem(409, "order-refused", "Order refused", "This order cannot run right now.");
  return new Problem(409, `refused:${first.limit}`, first.title, describeRefusals(refusals));
}
