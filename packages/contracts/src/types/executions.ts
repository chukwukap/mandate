import type { ExecutionStatus, TransactionLeg } from "./primitives.js";

/**
 * The state one order is in, and what the executor will do about it next.
 *
 * `executions.status` and `executions.stage` are two independent axes and both matter. The
 * status says how far the order got; the stage says which transaction leg it is sitting on.
 * Reading either one alone gives a wrong answer: an order at `pending`/`fund` has money
 * leaving the account, and an order at `pending`/`refund` has money coming back.
 */

/**
 * The value of `executions.stage`.
 *
 * A leg while one is outstanding, and "done" once the lifecycle has finished with the order.
 * "done" is not a leg and never appears in the `transactions` journal — the `transaction_leg_valid`
 * CHECK would reject it — which is exactly why it needs its own name here instead of being
 * smuggled into the leg union.
 */
export type ExecutionStage = TransactionLeg | "done";

/**
 * The legs that move an order forward, in the order they are attempted.
 *
 * approve → swap, both signed by the user's own wallet. Each is conditional on the instance
 * still being armed, still in auto mode, and untouched since the order was admitted: the
 * lifecycle re-reads and re-checks that under a row lock before it journals either, because a
 * user who pauses a strategy has withdrawn consent for the next transfer, not just the next tick.
 */
export const FORWARD_LEGS: readonly TransactionLeg[] = Object.freeze(["approve", "swap"]);

/**
 * Nothing unwinds. USDC sits in the user's wallet until the swap moves it into the pool in the
 * same transaction that delivers the shares; a stale router allowance is the only residue of an
 * order that stopped between legs, and it is harmless.
 */
export const UNWIND_LEGS: readonly TransactionLeg[] = Object.freeze([]);

export function isUnwindLeg(leg: TransactionLeg): boolean {
  return (UNWIND_LEGS as readonly string[]).includes(leg);
}

/**
 * The four dispositions every execution status falls into, and what each one is waiting on.
 *
 * - `signalled` the strategy fired and the system deliberately did not trade. This is manual
 *               mode working, not a failure, and nothing will ever advance it. The executor
 *               guards on it explicitly: handed a signal's id the lifecycle has no check of
 *               its own and would fund, approve and swap a trade the user chose to place by
 *               hand.
 * - `working`   the executor will advance this order on its next pass.
 * - `settled`   finished. No further transaction will be signed for it.
 * - `operator`  the onchain evidence is inconsistent — a settled receipt that no longer
 *               matches the chain, or a submitted transaction that never resolved. The
 *               strategy is halted and a human inspects the journal. No timer changes this,
 *               which is why it is not `working`.
 */
export type ExecutionDisposition = "signalled" | "working" | "settled" | "operator";

export function executionDisposition(status: ExecutionStatus): ExecutionDisposition {
  switch (status) {
    case "signal":
      return "signalled";
    case "admitted":
    case "pending":
      return "working";
    case "confirmed":
    case "reverted":
    case "cancelled":
    case "refunded":
      return "settled";
    case "recovery_required":
      return "operator";
  }
}

/**
 * Finished orders.
 *
 * Exactly the set `apps/worker/src/jobs/execute-intent.ts` skips as "order-settled": it
 * excludes `signal` and `recovery_required` because those are also never advanced but for
 * different reasons, and reporting all six under one code would hide a stuck order needing an
 * operator among the ordinary completed ones.
 */
export const SETTLED_EXECUTION_STATUSES: readonly ExecutionStatus[] = Object.freeze([
  "confirmed",
  "reverted",
  "cancelled",
  "refunded",
]);

/** Takes a `string`: `ExecutionRow.status` is a `text` column and drizzle types it as one. */
export function isSettledExecutionStatus(status: string): boolean {
  return (SETTLED_EXECUTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses that guarantee no transaction was ever signed against the user's permission.
 *
 * This is a promise made to a user, so it is drawn tightly:
 *
 * - `signal`    manual mode. The order exists as a record of a decision; nothing was submitted.
 * - `admitted`  the executor has not reached it. The lifecycle journals the signed transaction
 *               and moves the order to `pending` in the *same* commit, before anything is
 *               broadcast, so an order still at `admitted` has no signed bytes anywhere.
 * - `cancelled` the lifecycle only cancels before a funding leg exists.
 *
 * `pending` is absent even though a pending order may not have broadcast yet: a signed
 * transaction is recoverable and may still land, and "nothing was spent" must not be claimed
 * about an order that could settle a second later. `reverted` is absent because a reverted
 * swap can follow a funding leg that succeeded.
 *
 * Note what this does not say: `admitted` has already consumed period and lifetime budget in
 * the instance's runtime counters. Reservations are never credited back, so no spend onchain
 * is not the same as no budget used.
 */
export const NO_ONCHAIN_SPEND_STATUSES: readonly ExecutionStatus[] = Object.freeze([
  "signal",
  "admitted",
  "cancelled",
]);

export function guaranteesNoOnchainSpend(status: string): boolean {
  return (NO_ONCHAIN_SPEND_STATUSES as readonly string[]).includes(status);
}
