import { Problem } from "@mandate/contracts";
import { type DraftRow, type InstanceRow, type Repository, schema } from "@mandate/database";
import { and, eq } from "drizzle-orm";

export type LifecycleAction = "arm" | "pause" | "kill";

/** Statuses no transition can leave. Mirrors the `instance_status_valid` check constraint. */
export const TERMINAL: readonly string[] = ["halted", "ended"];

/**
 * The halt reason written when a signed envelope's expiry has passed.
 *
 * Byte-identical to the string packages/execution/src/admission.ts writes for the same event.
 * Two writers describing one condition in two ways is how a history panel ends up showing a
 * strategy that "expired" and a sibling that was "Strategy expired" — and how a support query
 * for one of them silently misses the other.
 */
export const EXPIRY_REASON = "Strategy expired";

export function expiredProblem() {
  return new Problem(
    409,
    "expired",
    "Strategy expired",
    "The signed strategy has expired. Create and sign a fresh strategy.",
  );
}

export function terminalProblem() {
  return new Problem(
    409,
    "terminal-instance",
    "Strategy has ended",
    "A halted or ended strategy needs a new signed draft.",
  );
}

/**
 * The complete transition table, as a pure function so it can be asserted directly.
 *
 *            arm            pause          kill
 *   armed    apply (renew)  apply          apply
 *   paused   apply          apply          apply
 *   halted   409 terminal   409 terminal   noop (already stopped)
 *   ended    409 expired    409 expired    noop (already stopped)
 *
 * Four deliberate answers, each of which a naive table gets wrong:
 *
 * - arm on an already-armed instance is a 200 renewal, not a 409. Arming rewrites
 *   eligible_country and eligibility_expires_at for another 24 hours, and the worker pauses an
 *   instance whose attestation lapsed. Calling the renewal illegal would strand exactly those
 *   users, whose only recovery would be signing an entirely new draft.
 * - pause on paused and kill on halted are idempotent 200s. A stop button that returns a
 *   conflict when the thing is already stopped trains users to retry a destructive action.
 * - kill on a terminal instance is "noop", not "apply": the repository would take a row lock,
 *   re-read, and write nothing. Skipping it saves the lock and, more importantly, stops kill
 *   from overwriting a real halt reason ("Drawdown limit reached") with "Stopped by user".
 * - "ended" and "halted" are both terminal but are not the same event, so they do not share a
 *   code. Nothing in this system writes "ended" for any reason other than a lapsed envelope —
 *   packages/execution/src/admission.ts and guardLifecycle below are its only two writers, and
 *   both pair it with EXPIRY_REASON — so "ended" *is* the expiry, and "expired" is the answer
 *   that tells the user their authority ran out rather than that somebody stopped it.
 *   "halted" keeps "terminal-instance", because its own halt_reason is the specific truth and a
 *   strategy the user killed must never be reported back to them as expired.
 *
 * Expiry is not a status, so this function does not consider it. guardLifecycle materialises a
 * lapsed envelope into "ended" under the row lock *before* this is consulted, which is what
 * makes a status-only table sufficient — and is why the two live in one file.
 *
 * An unrecognised status is treated as non-terminal, which is what Repository.transition does
 * with it too; the check constraint means it cannot occur, and agreeing with the repository is
 * better than inventing a fifth answer here.
 */
export function decideTransition(
  status: string,
  action: LifecycleAction,
): "apply" | "noop" | Problem {
  if (!TERMINAL.includes(status)) return "apply";
  if (action === "kill") return "noop";
  return status === "ended" ? expiredProblem() : terminalProblem();
}

export type LifecycleGuard = {
  /**
   * The locked row, with a lapsed envelope already reflected in `status`.
   *
   * Post-condition, and the whole point of the guard: a live instance whose authority has run
   * out comes back as "ended", so decideTransition can be a function of status alone.
   */
  instance: InstanceRow;
  draft: DraftRow;
  /** The signed envelope's expiry has passed. Always true once `instance.status` is "ended". */
  expired: boolean;
};

/**
 * Reads an owned instance under `FOR UPDATE` and materialises expiry before anything decides.
 *
 * The stored status is not the whole truth. Expiry is a fact about the signed envelope, and
 * nothing writes it into the row until the worker next ticks that instance — so an instance
 * whose caps.expires_at passed while the worker was down (or which was paused, and therefore
 * never scheduled again) sits at "armed" indefinitely. Reading that row and acting on it is how
 * `pause` used to answer 200 "paused" for a strategy that is actually over, and how `kill`
 * recorded "Stopped by user" for one that expired days earlier.
 *
 * The UPDATE runs inside Repository.locked's transaction, holding the same row lock the worker
 * takes, so it cannot race the worker's own expiry write; both write status "ended" with
 * EXPIRY_REASON, so a tie is indistinguishable either way. Only status/halt_reason/updated_at
 * are touched, which is exactly the set the immutable_instance trigger permits.
 *
 * `last_tick_at` and `next_tick_at` are deliberately left alone: they describe worker activity,
 * and this is the API observing a deadline, not a tick. `due()` selects on status = 'armed', so
 * an ended row stops being scheduled regardless of its next_tick_at.
 *
 * Throws Problem.notFound() — via Repository.locked under RLS — for an id belonging to another
 * user or to nobody, so existence is never disclosed.
 */
export async function guardLifecycle(
  repo: Repository,
  user: string,
  id: string,
  now: Date,
): Promise<LifecycleGuard> {
  return repo.locked(user, id, async (tx, instance, draft) => {
    const expiresAt = Date.parse(draft.envelope.caps.expires_at);
    // An unparseable expiry counts as expired. capsSchema (z.iso.datetime) makes it
    // unreachable, and if it ever were reachable, refusing to keep trading under an authority
    // whose deadline cannot be read is the only safe direction.
    const expired = !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
    // A row that already stopped keeps its own reason. Overwriting "Drawdown limit reached" with
    // "Strategy expired" a day later would erase the only record of why it actually stopped, and
    // would turn the 409 for a strategy the user killed into a misleading "expired".
    if (!expired || TERMINAL.includes(instance.status)) return { instance, draft, expired };
    const [ended] = await tx
      .update(schema.instances)
      .set({ status: "ended", haltReason: EXPIRY_REASON, updatedAt: now })
      .where(and(eq(schema.instances.id, id), eq(schema.instances.userId, user)))
      .returning();
    // The UPDATE returns no row only if this one vanished under the lock, which cannot happen —
    // nothing deletes instances. Projecting the write locally anyway keeps the post-condition
    // ("status is the truth") total, so no caller has to re-derive expiry from the envelope.
    return {
      instance: ended ?? {
        ...instance,
        status: "ended",
        haltReason: EXPIRY_REASON,
        updatedAt: now,
      },
      draft,
      expired,
    };
  });
}
