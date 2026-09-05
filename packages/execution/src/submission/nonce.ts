import type { Hex } from "@mandate/contracts";
import type { JournalEntry } from "./types.js";

/**
 * Nonce policy for a single shared spender key.
 *
 * One key signs for every order and every owner, so the nonce is the narrowest shared
 * resource in the system and the only one where a mistake spends real money twice. The
 * policy is deliberately austere: at most one transaction from this key may be unsettled at
 * a time, and a nonce is never chosen while anything about the key's state is unexplained.
 *
 * That costs throughput — orders queue behind each other — and the worker already accepts
 * that trade (`docs/architecture/worker.md`: "One leader processes one automatic order at a
 * time"). The alternative, a nonce pool with gap tracking, is not merely more code: with a
 * `fund` leg that pulls a user's USDC, a mis-sequenced pool strands money in a server
 * wallet, and there is no version of that failure worth the extra orders per minute.
 *
 * What makes a double-send impossible is the combination of three things, and no single one
 * of them is sufficient:
 *
 *  1. This function refuses to pick a nonce whenever the journal or the chain shows
 *     anything unaccounted for.
 *  2. `mandate_v2.transactions` has UNIQUE (signer, nonce) and UNIQUE (execution_id, leg).
 *     Two workers that both got past (1) — a leader fence that lapsed, a database restored
 *     from a backup — collide at the commit, and the loser never broadcasts because the
 *     pipeline broadcasts only what it recorded.
 *  3. Re-BROADCASTING identical bytes is free and idempotent, so recovery never needs to
 *     re-SIGN. That distinction is the whole safety argument: two different signatures at
 *     one nonce is a race the chain resolves arbitrarily; the same signature twice is one
 *     transaction.
 *
 * There is deliberately no fee replacement. Replacing a stuck transaction means signing
 * DIFFERENT bytes at a nonce that may already be mining, and on the `fund` leg the two
 * candidates are "pull the user's money" and "pull the user's money" — whichever wins, the
 * other must not also win, and nothing in this process can guarantee that from outside the
 * chain. A stuck transaction escalates to an operator instead.
 */

export type NonceFacts = {
  readonly signer: Hex;
  /** `eth_getTransactionCount` at `latest`: every nonce below this is consumed by a block. */
  readonly latest: number;
  /** At `pending`: `latest` plus whatever this node holds in its own mempool. */
  readonly pending: number;
  /** Every journal row for this signer, across all orders and all owners. */
  readonly entries: readonly JournalEntry[];
  /** The order and leg being prepared, so an existing row for it can be recognised. */
  readonly executionId: string;
  readonly leg: string;
};

export type NonceBlockCode =
  /** `pending > latest` with nothing in the journal to explain it: bytes we did not sign. */
  | "foreign-pending"
  /** The counts disagree with themselves. An RPC that contradicts itself is not a source. */
  | "inconsistent-counts"
  /** Another order's leg is still unsettled. One key, one transaction in flight. */
  | "unsettled-leg"
  /** Our own unsettled row sits at a nonce the chain has already consumed. */
  | "consumed-unsettled"
  /** A row we recorded as settled sits at a nonce the chain says is still free. */
  | "journal-ahead"
  /** The nonce we would pick already has a row. Never overwrite; never reuse. */
  | "nonce-taken";

export type NoncePlan =
  /** Sign fresh bytes at `nonce`. */
  | { readonly kind: "sign"; readonly nonce: number }
  /**
   * Do not sign. Bytes for this exact order and leg already exist and have not settled;
   * send those. This is the crash-recovery path and the only correct response to finding
   * our own unsettled row.
   */
  | { readonly kind: "resend"; readonly entry: JournalEntry }
  /**
   * Do not sign, do not send. The key's state cannot be explained, so any action is a
   * guess. `nonce` is included when one is known, purely so an operator report can name it.
   */
  | {
      readonly kind: "blocked";
      readonly code: NonceBlockCode;
      readonly detail: string;
      readonly nonce: number | null;
    };

const UNSETTLED = "signed";

function forSigner(entries: readonly JournalEntry[], signer: Hex): JournalEntry[] {
  const key = signer.toLowerCase();
  return entries.filter((entry) => entry.signer.toLowerCase() === key);
}

/**
 * Decide what may be signed or sent for this key, right now.
 *
 * Pure, and ordered so that the most dangerous ambiguity is caught before the most
 * convenient answer. In particular the "our own unsettled row" case is examined BEFORE the
 * `pending`/`latest` comparison: a row we signed and broadcast is exactly what makes
 * `pending` exceed `latest`, and treating our own in-flight transaction as foreign activity
 * would halt the worker every time it did its job correctly.
 */
export function planNonce(facts: NonceFacts): NoncePlan {
  const { latest, pending } = facts;
  if (!Number.isInteger(latest) || !Number.isInteger(pending) || latest < 0 || pending < latest)
    return {
      kind: "blocked",
      code: "inconsistent-counts",
      detail:
        "The node reported a pending transaction count below its latest count; it cannot be used to choose a nonce.",
      nonce: null,
    };

  const mine = forSigner(facts.entries, facts.signer);
  const unsettled = mine.filter((entry) => entry.status === UNSETTLED);

  // Our own row for this exact order and leg. Resend, never re-sign.
  const own = unsettled.find(
    (entry) => entry.executionId === facts.executionId && entry.leg === facts.leg,
  );
  if (own) {
    if (own.nonce < latest)
      // The chain consumed this nonce, so SOMETHING mined at it — our bytes or a
      // replacement. Which one it was is a receipt question, and answering it by resending
      // would at best be a no-op and at worst paper over a displaced transaction.
      return {
        kind: "blocked",
        code: "consumed-unsettled",
        detail: `Nonce ${own.nonce} has been consumed on chain but the ${own.leg} leg is still recorded as unsettled; its receipt must be read before anything else is sent.`,
        nonce: own.nonce,
      };
    return { kind: "resend", entry: own };
  }

  // Somebody else's leg is in flight. It advances one settled receipt at a time; this order
  // waits rather than queueing a second transaction behind it.
  const other = unsettled[0];
  if (other)
    return {
      kind: "blocked",
      code: "unsettled-leg",
      detail: `The spender key already has an unsettled ${other.leg} transaction at nonce ${other.nonce}; one transaction settles before another is signed.`,
      nonce: other.nonce,
    };

  // No unsettled rows anywhere, so this node should be holding nothing for this key.
  if (pending !== latest)
    return {
      kind: "blocked",
      code: "foreign-pending",
      detail: `The node holds ${pending - latest} pending transaction(s) for the spender key that this worker did not sign.`,
      nonce: null,
    };

  // Everything left in the journal is settled, so every one of those nonces was consumed by
  // a block and must sit strictly below `latest`. Two distinct contradictions live above
  // that line and they mean different things to an operator, so they are reported apart.

  // The exact slot we would use is already recorded. Defence in depth ahead of the
  // database's UNIQUE (signer, nonce): a clean refusal beats a constraint violation
  // surfacing as an opaque write failure halfway through the pipeline.
  const taken = mine.find((entry) => entry.nonce === latest);
  if (taken)
    return {
      kind: "blocked",
      code: "nonce-taken",
      detail: `The journal already holds a ${taken.status} ${taken.leg} transaction at nonce ${latest}, which the chain reports as not yet consumed.`,
      nonce: latest,
    };

  // A settled row beyond the next free nonce: the journal holds a receipt for a nonce the
  // chain says was never used. A reorg deep enough to unwind a confirmed transaction, a
  // restored backup, or an RPC serving a different chain than the one we signed against.
  const ahead = mine.find((entry) => entry.nonce > latest);
  if (ahead)
    return {
      kind: "blocked",
      code: "journal-ahead",
      detail: `The journal records a ${ahead.status} ${ahead.leg} transaction at nonce ${ahead.nonce}, but the chain reports only ${latest} consumed nonce(s) for this key.`,
      nonce: ahead.nonce,
    };

  return { kind: "sign", nonce: latest };
}
