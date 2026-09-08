import type { Hex } from "@mandate/contracts";
import type { Leg, Observation } from "@mandate/execution";
import type { ChainFacts, Diagnosis, LegFacts, NonceState, StuckDecision } from "./types.js";

/**
 * FEE REPLACEMENT POLICY: wait, then rebroadcast, then escalate. Never replace.
 *
 * The runbook lists fee replacement as future work. It is not: it is structurally excluded
 * by this system's durability rules, and excluding it is what makes recovery decidable.
 *
 * Why it cannot be journaled. Migration 0005's `protect_transaction()` rejects any UPDATE
 * to `transactions` that changes a column other than `status`/`confirmed_at`, and rejects
 * every DELETE. `UNIQUE(execution_id, leg)` forbids a second row for the same leg and
 * `UNIQUE(signer, nonce)` forbids a second row at the same nonce. So replacement bytes have
 * nowhere to live. `WorkerChain.broadcast` then refuses any bytes whose keccak256 does not
 * match the journaled hash, and the whole design rests on this process never sending
 * unjournaled bytes.
 *
 * Why it would not help anyway. Base is a single-sequencer OP-Stack chain with 2 s blocks
 * and no public mempool auction. A transaction still unmined after ~15 blocks is not losing
 * a priority-fee race; it was dropped, or an earlier nonce is blocking it. And the dominant
 * cost on an L2 is the L1 data fee, which no `maxFeePerGas` bump changes. Resending the
 * IDENTICAL bytes fixes the first cause. Nothing this transaction does fixes the second —
 * only the transaction at the missing nonce can.
 *
 * Why the exclusion is load-bearing. Exactly one set of bytes per (signer, nonce) means at
 * most one transaction can ever mine for that nonce, which is what lets `observe()` decide
 * an outcome from a single hash. With two candidate hashes per nonce, "no receipt at a
 * consumed nonce" — today's unambiguous danger signal — becomes routine and unreadable. On
 * a leg that pulls real USDC under a user's spend permission, that trade is not worth the
 * seconds of latency a fee bump might buy.
 *
 * FORWARD RISK. If fee replacement is ever added it needs BOTH a migration relaxing those
 * constraints AND a change to `WorkerChain.observe` to resolve a SET of hashes per nonce.
 * Doing the first without the second makes every replacement read `ambiguous` and halts the
 * entire fleet, because `recovery_required` blocks admissions across all owners.
 */

/**
 * Grace period before a receipt-less transaction whose nonce is still free is called
 * dropped. A transaction accepted seconds ago may not yet be reflected in this node's
 * pending count, especially behind a load-balanced public endpoint.
 */
export const DEFAULT_REBROADCAST_AFTER_MS = 60_000;

export type StuckPolicy = {
  readonly receiptTimeoutMs: number;
  readonly rebroadcastAfterMs: number;
};

/**
 * Decide what to do about one transaction that has not settled.
 *
 * Pure, so the whole decision table is testable without a database or an RPC. The nonce
 * arithmetic is the substance:
 *
 * - `latest > n`  the nonce is consumed. Our bytes either mined (the caller already has a
 *                 receipt) or were displaced. Either way, waiting changes nothing.
 * - `latest < n`  nonces `latest .. n-1` are unconsumed, so this transaction physically
 *                 cannot be included yet. Bumping ITS fee is useless; the block is on an
 *                 earlier nonce.
 * - `latest === n && pending === latest`  the node is holding nothing at our nonce. The
 *                 bytes are gone from the mempool and only a resend brings them back.
 */
export function classifyStuck(input: {
  observed: Observation | "unavailable";
  nonce: NonceState | null;
  txNonce: number;
  ageMs: number;
  policy: StuckPolicy;
}): StuckDecision {
  const { observed, nonce, txNonce, ageMs, policy } = input;
  // Acting on an unreadable chain is how a recovery pass turns one stuck order into two.
  if (observed === "unavailable" || !nonce) return "wait";
  if (observed === "confirmed" || observed === "reverted") return "none";
  if (observed === "ambiguous") return "escalate";
  if (nonce.latest > txNonce) return "escalate";
  if (nonce.latest < txNonce) return "escalate";
  if (nonce.pending <= txNonce) return ageMs >= policy.rebroadcastAfterMs ? "rebroadcast" : "wait";
  return ageMs >= policy.receiptTimeoutMs ? "escalate" : "wait";
}

function settledLegs(legs: readonly LegFacts[]) {
  return legs.filter((l) => l.transaction.status !== "signed");
}

/** A settled leg whose re-observation contradicts what the journal recorded. */
function contradiction(legs: readonly LegFacts[]) {
  return settledLegs(legs).find(
    (l) => l.observed !== "unavailable" && l.observed !== l.transaction.status,
  );
}

function unverifiable(legs: readonly LegFacts[]) {
  return settledLegs(legs).find((l) => l.observed === "unavailable");
}

function has(legs: readonly LegFacts[], leg: Leg, status: string) {
  return legs.some((l) => l.transaction.leg === leg && l.transaction.status === status);
}

/**
 * True when nonces beyond everything this worker ever journaled have been consumed, or when
 * the node holds something pending that no journal row explains.
 *
 * Either means the key is not exclusively ours, which invalidates the assumption every
 * other decision here rests on. An incomplete journal read (owner paging hit its bound) is
 * treated as "cannot tell", not as "foreign".
 */
export function foreignActivity(facts: ChainFacts) {
  const { nonce, journal } = facts;
  if (!nonce || !journal?.complete) return false;
  if (nonce.latest > journal.ceiling) return true;
  const explained = new Set(journal.unsettled);
  for (let n = nonce.latest; n < nonce.pending; n += 1) if (!explained.has(n)) return true;
  return false;
}

/**
 * Classify an order sitting in `recovery_required` from its journal and observed chain
 * facts. No RPC, no database, no clock beyond `facts.now`.
 *
 * Order of precedence is deliberate, most dangerous first:
 *  1. the journal's signer is not the configured spender — nothing else can be trusted;
 *  2. a settled receipt changed;
 *  3. an in-flight leg's fate;
 *  4. an unverifiable observation;
 *  5. foreign use of the key;
 *  6. money sitting in the spender wallet;
 *  7. everything reconciles.
 */
export function diagnose(
  _order: { status: string; stage: string },
  facts: ChainFacts,
  policy: StuckPolicy,
): Diagnosis {
  const signed = facts.legs.find((l) => l.transaction.status === "signed");
  const at = (l: LegFacts | undefined) => ({
    leg: (l?.transaction.leg ?? null) as Leg | null,
    transactionId: l?.transaction.id ?? null,
    hash: (l?.transaction.hash ?? null) as Hex | null,
    nonce: l?.transaction.nonce ?? null,
    observed: l?.observed ?? null,
  });

  if (facts.signerMismatch)
    return {
      ...at(signed ?? facts.legs[0]),
      code: "unattributable",
      decision: "escalate",
      settle: null,
      clearable: false,
      detail:
        "Journal signer does not match the configured spender address; no chain fact can be attributed to this worker.",
    };

  const changed = contradiction(facts.legs);
  if (changed)
    return {
      ...at(changed),
      code: "receipt-changed",
      decision: "escalate",
      settle: null,
      clearable: false,
      detail: `Leg ${changed.transaction.leg} is recorded ${changed.transaction.status} but now observes ${changed.observed}.`,
    };

  if (signed) {
    const ageMs = facts.now - signed.transaction.createdAt.getTime();
    const decision = classifyStuck({
      observed: signed.observed,
      nonce: facts.nonce,
      txNonce: signed.transaction.nonce,
      ageMs,
      policy,
    });
    if (signed.observed === "confirmed" || signed.observed === "reverted") {
      // THE CRASH REPAIR. The bytes were journaled before broadcast, so the transaction was
      // never lost; what a crash between broadcast and the status write loses is the
      // RECORD of its receipt. Writing it is the one journal mutation migration 0005 allows.
      const settledClean =
        signed.observed === "confirmed" || !["reset", "refund"].includes(signed.transaction.leg);
      return {
        ...at(signed),
        code: signed.observed === "confirmed" ? "settled-confirmed" : "settled-reverted",
        decision: "none",
        settle: { transactionId: signed.transaction.id, status: signed.observed },
        clearable:
          settledClean &&
          !unverifiable(facts.legs) &&
          !foreignActivity(facts) &&
          !returnFailed(facts.legs),
        detail: `Leg ${signed.transaction.leg} settled ${signed.observed} on chain but was journaled as still signed; recording the receipt.`,
      };
    }
    if (signed.observed === "ambiguous") {
      const located = facts.located;
      const displaced =
        located?.found === true &&
        located.hash.toLowerCase() !== signed.transaction.hash.toLowerCase();
      return {
        ...at(signed),
        code: displaced ? "displaced-by-foreign-transaction" : "unattributable",
        decision: "escalate",
        settle: null,
        clearable: false,
        detail: displaced
          ? `Nonce ${signed.transaction.nonce} was consumed by ${located.hash} (${located.call.kind}), not by the journaled bytes; those bytes can never mine.`
          : `Nonce ${signed.transaction.nonce} is consumed with no receipt for the journaled hash, and the transaction at that nonce could not be located.`,
      };
    }
    if (signed.observed === "unavailable")
      return {
        ...at(signed),
        code: "unattributable",
        decision,
        settle: null,
        clearable: false,
        detail: "Receipt observation failed; the outcome of the in-flight leg is unknown.",
      };
    if (decision === "escalate" && facts.nonce && facts.nonce.latest < signed.transaction.nonce)
      return {
        ...at(signed),
        code: "blocked-by-nonce-gap",
        decision,
        settle: null,
        clearable: false,
        detail: `Nonce ${signed.transaction.nonce} cannot be included while nonce ${facts.nonce.latest} is unconsumed; the transaction at the lower nonce must be resent.`,
      };
    return {
      ...at(signed),
      code: decision === "rebroadcast" ? "dropped-rebroadcast" : "awaiting-inclusion",
      decision,
      settle: null,
      clearable: false,
      detail:
        decision === "rebroadcast"
          ? "No receipt, the nonce is still free and the node holds nothing pending: the bytes were dropped and need resending unchanged."
          : `Still awaiting inclusion after ${Math.round(ageMs / 1000)}s.`,
    };
  }

  const blind = unverifiable(facts.legs);
  if (blind)
    return {
      ...at(blind),
      code: "unattributable",
      decision: "wait",
      settle: null,
      clearable: false,
      detail: `Leg ${blind.transaction.leg} could not be re-observed, so the journal cannot be confirmed consistent.`,
    };

  if (foreignActivity(facts))
    return {
      ...at(undefined),
      code: "foreign-signer-activity",
      decision: "escalate",
      settle: null,
      clearable: false,
      detail:
        "The spender key has consumed nonces this worker never journaled, or holds an unexplained pending transaction.",
    };

  if (returnFailed(facts.legs))
    return {
      ...at(facts.legs.find((l) => returnLeg(l) && l.transaction.status === "reverted")),
      code: "stranded-input",
      decision: "escalate",
      settle: null,
      clearable: false,
      detail:
        "The allowance reset or the refund reverted, so funded USDC is held by the spender with its automatic return path already failed.",
    };

  if (
    has(facts.legs, "fund", "confirmed") &&
    !has(facts.legs, "swap", "confirmed") &&
    !has(facts.legs, "refund", "confirmed")
  )
    return {
      ...at(undefined),
      code: "stranded-input",
      decision: "none",
      settle: null,
      clearable: true,
      detail:
        "Funding confirmed with no confirmed swap or refund; the journal is consistent, so the return path can resume.",
    };

  return {
    ...at(undefined),
    code: "journal-consistent",
    decision: "none",
    settle: null,
    clearable: true,
    detail: "Every journaled leg re-observes exactly as recorded and nothing is in flight.",
  };
}

function returnLeg(l: LegFacts) {
  return l.transaction.leg === "reset" || l.transaction.leg === "refund";
}

/**
 * A reverted `reset` or `refund` must never be cleared back to Lifecycle.
 *
 * Lifecycle's own rule is `refund or reset reverted -> recovery_required`. Clearing such an
 * order would have Lifecycle write it straight back on the next poll, and the two would
 * take turns rewriting the row on every 2-second cycle for as long as the worker runs.
 */
function returnFailed(legs: readonly LegFacts[]) {
  return legs.some((l) => returnLeg(l) && l.transaction.status === "reverted");
}
