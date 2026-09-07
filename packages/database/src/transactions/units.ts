import { Problem } from "@mandate/contracts";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "../client.js";
import {
  type ExecutionRow,
  executions,
  type InstanceRow,
  instances,
  type PermissionRow,
  permissions,
  type TransactionRow,
  transactions,
} from "../schema/index.js";
import { isUniqueViolation } from "./errors.js";
import { withTenant } from "./tenant.js";
import type { Executor, TransactionOptions } from "./unit.js";

/**
 * The two writes that must never be half-applied.
 *
 * Both are pairs. A permission row that says "active" while its instance still says "manual" is
 * an authority nobody will use; an instance that says "auto" while its permission is still
 * "prepared" is an instance the worker will try to execute with no signature behind it. A
 * `transactions` row without its `executions` update is a broadcast the lifecycle will replay,
 * and an `executions` update without its `transactions` row is a live position with no journal
 * entry — money moved on Base and nothing in the database knows which transaction moved it.
 *
 * Each unit takes a `Transaction`, not a `Database`, so it is always *part of* a caller's atom
 * rather than an atom of its own. The `record*` wrappers below are the convenience form for
 * callers that have nothing else to commit.
 *
 * The field sets these units are allowed to touch are not a matter of taste. Migration 0002 and
 * 0005 install BEFORE UPDATE triggers that raise 23514 on any other column:
 *
 * - `permissions`: only `status`, `signature`, `updated_at`, and `signature` is write-once.
 * - `executions`: only `status`, `stage`, `reason`, `tx_hash`, `updated_at`.
 * - `transactions`: only `status` and `confirmed_at`, and only while status is still 'signed'.
 *   DELETE is refused outright — the journal is append-only.
 *
 * So the patch types below are narrow on purpose. Widening one turns a compile error into a
 * runtime 23514 from a trigger, at whichever call site happens to run first.
 */

export type PermissionStatus = "prepared" | "signed" | "active" | "revoked" | "expired";
export type InstanceMode = "manual" | "auto";
export type InstanceStatus = "armed" | "paused" | "halted" | "ended";

export type PermissionGrant = {
  readonly userId: string;
  readonly instanceId: string;
  readonly permissionId: string;
  /**
   * The `permissions.hash` the caller read before deciding what to write.
   *
   * The hash is the EIP-712 digest of the payload, so a different hash is a different
   * authorization — a permission the user re-prepared while this request was in flight. Writing
   * "active" against it would activate a grant nobody in this request ever looked at.
   */
  readonly expectedHash: string;
  readonly status: PermissionStatus;
  /** Write-once. Pass it only on the transition that first attaches a signature. */
  readonly signature?: string | undefined;
  /** Applied to the instance in the same commit. Omitted keys are left as they are. */
  readonly instance?:
    | {
        readonly mode?: InstanceMode | undefined;
        readonly status?: InstanceStatus | undefined;
        readonly haltReason?: string | null | undefined;
      }
    | undefined;
  readonly now: Date;
};

/**
 * Write a permission transition and the instance state that depends on it, together.
 *
 * Lock order is instances then permissions, and it is not arbitrary: `Repository.locked` — which
 * every lifecycle transition in the API goes through — takes `instances FOR UPDATE` first. A
 * unit that took the permission row first would deadlock against an arm/pause running at the
 * same moment, and PostgreSQL would resolve it by killing one of the two at random. Taking the
 * locks in the same order everywhere turns that into a wait.
 */
export async function writePermissionGrant(
  tx: Transaction,
  grant: PermissionGrant,
): Promise<{ permission: PermissionRow; instance: InstanceRow }> {
  const [instance] = await tx
    .select()
    .from(instances)
    .where(and(eq(instances.id, grant.instanceId), eq(instances.userId, grant.userId)))
    .for("update");
  if (!instance) throw Problem.notFound();

  const [current] = await tx
    .select()
    .from(permissions)
    .where(
      and(
        eq(permissions.id, grant.permissionId),
        eq(permissions.userId, grant.userId),
        eq(permissions.instanceId, grant.instanceId),
      ),
    )
    .for("update");
  if (!current) throw Problem.notFound();
  if (current.hash !== grant.expectedHash)
    throw new Problem(
      409,
      "permission-state",
      "Permission changed",
      "Refresh the permission before continuing.",
    );

  const [permission] = await tx
    .update(permissions)
    .set({
      status: grant.status,
      updatedAt: grant.now,
      // Only ever set, never cleared: the trigger rejects a change to a non-null signature, and
      // a caller passing undefined means "leave the stored one alone", not "drop it".
      ...(grant.signature === undefined ? {} : { signature: grant.signature }),
    })
    .where(and(eq(permissions.id, grant.permissionId), eq(permissions.userId, grant.userId)))
    .returning();
  if (!permission) throw new Error("Permission update matched no row under a held lock");

  const patch = grant.instance ?? {};
  const [updated] = await tx
    .update(instances)
    .set({
      updatedAt: grant.now,
      ...(patch.mode === undefined ? {} : { mode: patch.mode }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.haltReason === undefined ? {} : { haltReason: patch.haltReason }),
    })
    .where(and(eq(instances.id, grant.instanceId), eq(instances.userId, grant.userId)))
    .returning();
  if (!updated) throw new Error("Instance update matched no row under a held lock");
  return { permission, instance: updated };
}

export type TransactionLeg = "fund" | "approve" | "swap" | "reset" | "refund";
export type ExecutionStatus =
  | "signal"
  | "admitted"
  | "pending"
  | "confirmed"
  | "reverted"
  | "cancelled"
  | "refunded"
  | "recovery_required";

export type ExecutionLeg = {
  readonly userId: string;
  readonly executionId: string;
  readonly id: string;
  readonly leg: TransactionLeg;
  readonly signer: string;
  readonly nonce: number;
  readonly rawTransaction: string;
  /** The transaction hash implied by `rawTransaction`. Unique across the whole journal. */
  readonly hash: string;
  readonly evidence?: TransactionRow["evidence"] | undefined;
  /** Applied to the parent execution in the same commit. */
  readonly execution?:
    | {
        readonly status?: ExecutionStatus | undefined;
        readonly stage?: string | undefined;
        readonly reason?: string | null | undefined;
        readonly txHash?: string | null | undefined;
      }
    | undefined;
  readonly now: Date;
};

export type ExecutionLegResult = {
  readonly transaction: TransactionRow;
  readonly execution: ExecutionRow;
  /** True when the journal already held this exact leg and nothing new was inserted. */
  readonly replayed: boolean;
};

/**
 * A signer reused a nonce that another execution already claimed.
 *
 * Not a `Problem`: no HTTP caller can fix it and no retry will clear it. Two signed
 * transactions sharing a nonce means at most one can ever confirm, and the worker cannot tell
 * which — the order must stop and be looked at, which is what `recovery_required` is for.
 */
export class NonceReused extends Error {
  constructor(
    readonly signer: string,
    readonly nonce: number,
  ) {
    super("Signer nonce already recorded for a different transaction");
  }
}

/**
 * Append one signed transaction to the journal and move its execution forward, atomically.
 *
 * This is the write the whole recovery story depends on. `Lifecycle.run` decides what to do next
 * by reading the journal, so a leg that was broadcast but not journalled is invisible: the next
 * poll re-derives the same leg, signs it again with a fresh nonce, and broadcasts a second
 * transaction doing the same swap. Both are valid. Both can confirm.
 *
 * Idempotency is the `execution_leg` unique constraint, not a prior SELECT. A read-then-insert
 * has a window; the constraint does not. On conflict the stored row is re-read and compared by
 * hash:
 *
 * - Same hash — this is a replay of a write that already committed (the caller crashed between
 *   commit and acknowledgement, or a retried unit re-ran). Return it and report `replayed`.
 * - Different hash — the caller signed a *second* transaction for a leg that already has one.
 *   That is the double-broadcast above, caught before it reaches the chain, and it is a hard
 *   failure rather than an overwrite because the journal is append-only by design.
 *
 * The insert happens before the execution update so that a `signer_nonce` collision aborts the
 * whole unit with nothing written. Doing it the other way round would leave the execution
 * claiming a stage the journal cannot account for.
 */
export async function writeExecutionLeg(
  tx: Transaction,
  leg: ExecutionLeg,
): Promise<ExecutionLegResult> {
  const [order] = await tx
    .select()
    .from(executions)
    .where(and(eq(executions.id, leg.executionId), eq(executions.userId, leg.userId)))
    .for("update");
  if (!order) throw Problem.notFound();

  let inserted: TransactionRow | undefined;
  try {
    [inserted] = await tx
      .insert(transactions)
      .values({
        id: leg.id,
        userId: leg.userId,
        executionId: leg.executionId,
        leg: leg.leg,
        signer: leg.signer,
        nonce: leg.nonce,
        rawTransaction: leg.rawTransaction,
        hash: leg.hash,
        status: "signed",
        createdAt: leg.now,
        ...(leg.evidence === undefined ? {} : { evidence: leg.evidence }),
      })
      // Scoped to one constraint on purpose. `transactions_hash_unique` and `signer_nonce` are
      // different questions and must still raise; only "this leg is already journalled" is an
      // expected outcome here.
      .onConflictDoNothing({ target: [transactions.executionId, transactions.leg] })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error, "signer_nonce")) throw new NonceReused(leg.signer, leg.nonce);
    throw error;
  }

  let replayed = false;
  let journalled = inserted;
  if (!journalled) {
    const [existing] = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.executionId, leg.executionId),
          eq(transactions.userId, leg.userId),
          eq(transactions.leg, leg.leg),
        ),
      );
    if (!existing) throw new Error("Journal conflict resolved to no row");
    if (existing.hash !== leg.hash)
      throw new Error(
        `Execution ${leg.executionId} already has a different ${leg.leg} transaction journalled`,
      );
    journalled = existing;
    replayed = true;
  }

  const patch = leg.execution ?? {};
  const [execution] = await tx
    .update(executions)
    .set({
      updatedAt: leg.now,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.stage === undefined ? {} : { stage: patch.stage }),
      ...(patch.reason === undefined ? {} : { reason: patch.reason }),
      ...(patch.txHash === undefined ? {} : { txHash: patch.txHash }),
    })
    .where(and(eq(executions.id, leg.executionId), eq(executions.userId, leg.userId)))
    .returning();
  if (!execution) throw new Error("Execution update matched no row under a held lock");
  return { transaction: journalled, execution, replayed };
}

/**
 * `repeatable read` for both units.
 *
 * Under `read committed` each statement takes a fresh snapshot, so the row a unit read with
 * `FOR UPDATE` can legitimately differ from the one it wrote against two statements later. Both
 * units make a decision from a first read (the permission hash, the journalled leg) and then
 * write on the strength of it, which is exactly the pattern `read committed` does not protect.
 * `repeatable read` turns that into a 40001, and `withTransaction` retries it.
 *
 * `serializable` would also work and costs more; neither unit reads a *range* it then depends on
 * staying empty, which is the case that needs predicate locking.
 */
export const UNIT_OPTIONS: TransactionOptions = { isolationLevel: "repeatable read" };

/** `writePermissionGrant` as a standalone unit of work, tenant-scoped and retried. */
export function recordPermissionGrant(executor: Executor, grant: PermissionGrant) {
  return withTenant(executor, grant.userId, UNIT_OPTIONS, (tx) => writePermissionGrant(tx, grant));
}

/** `writeExecutionLeg` as a standalone unit of work, tenant-scoped and retried. */
export function recordExecutionLeg(executor: Executor, leg: ExecutionLeg) {
  return withTenant(executor, leg.userId, UNIT_OPTIONS, (tx) => writeExecutionLeg(tx, leg));
}
