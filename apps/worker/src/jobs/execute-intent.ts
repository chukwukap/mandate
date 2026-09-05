import { schema, type Transaction, tenant } from "@mandate/database";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import { classify, jobResult, RETRY, record, rethrowFatal } from "./outcomes.js";
import type { ExecuteIntentPayload, JobDependencies, JobResult } from "./types.js";

/** Order statuses that will never advance again. Re-dispatching one is a no-op. */
const TERMINAL = ["confirmed", "reverted", "cancelled", "refunded"];

/**
 * Statuses that mean an order owns the single spender key right now. `admitted` is NOT
 * one of them: an admitted order has no signed nonce yet. `recovery_required` is, because
 * an operator reconciling it may be replacing a transaction at the signer's next nonce.
 */
const HOLDS_SIGNER = ["pending", "recovery_required"] as const;

/** Owners scanned per page while looking for the order that holds the signer. */
const OWNER_PAGE = 100;

/**
 * Advance one leg of one order.
 *
 * IDEMPOTENCY. There is no submit-then-record window to lose a crash inside, because
 * Lifecycle journals the signed bytes, hash, signer and nonce BEFORE anything is
 * broadcast and only a later read of a committed journal row can send them. A duplicate
 * delivery therefore lands in exactly one of four places:
 *
 * 1. Before the journal commit. The retry re-signs the same leg and the `execution_leg`
 *    unique index on (execution_id, leg) rejects the insert, rolling back the whole
 *    transaction. A leg can never be journaled twice, so a second `fund` cannot pull a
 *    second spend permission draw.
 * 2. After the journal commit, receipt still pending. The retry rebroadcasts byte-identical
 *    bytes at the identical nonce; the node answers "already known" and the chain sees one
 *    transaction. The `signer_nonce` unique index on (signer, nonce) makes two *different*
 *    in-flight transactions structurally impossible even if two runs raced, and
 *    `chain.prepare` refuses to sign at all while the signer's latest nonce differs from
 *    its pending nonce.
 * 3. After settlement. The precondition below sees a terminal status and returns without
 *    touching the chain.
 * 4. Concurrently with the first run. `store.write` runs inside a tenant transaction that
 *    takes SELECT ... FOR UPDATE on the instance before inserting, so the second commit
 *    serializes behind the first and then loses to the unique index in case 1.
 *
 * None of this depends on the queue delivering exactly once, on a job id, or on a lock the
 * scheduler holds. The uniqueness lives in PostgreSQL, where a crashed process cannot take
 * it with it.
 */
export async function executeIntent(
  deps: JobDependencies,
  payload: ExecuteIntentPayload,
): Promise<JobResult> {
  const { userId, executionId } = payload;
  const base = { job: "execute-intent" as const, userId, executionId };

  let before: Awaited<ReturnType<typeof load>>;
  try {
    // Never trust the payload's copy of the order: a queue entry can be older than the
    // receipt that already settled the leg it names.
    before = await load(deps, userId, executionId);
  } catch (error) {
    rethrowFatal(error);
    return record(deps.log, jobResult({ ...base, outcome: "failed", ...classify(error) }));
  }
  if (!before)
    return record(deps.log, jobResult({ ...base, outcome: "skipped", code: "order-unavailable" }));

  const { order, journal } = before;
  const scoped = { ...base, instanceId: order.instanceId };

  // Lifecycle has NO guard against a manual signal — it only early-returns on
  // `recovery_required`. Handed a signal's id it would fund, approve and swap a trade the
  // user chose to place by hand. This precondition is the only thing between a manual-only
  // strategy and a real transfer, so it must live here and not in the scheduler.
  if (order.status === "signal")
    return record(
      deps.log,
      jobResult({ ...scoped, outcome: "skipped", code: "manual-signal-order" }),
    );
  if (TERMINAL.includes(order.status))
    return record(
      deps.log,
      jobResult({
        ...scoped,
        outcome: "skipped",
        code: "order-settled",
        detail: { status: order.status, stage: order.stage, txHash: order.txHash },
      }),
    );
  if (order.status === "recovery_required")
    return record(
      deps.log,
      jobResult({
        ...scoped,
        outcome: "blocked",
        code: "recovery-required",
        // No timer changes this. An operator inspects the journal and decides.
        retryAfterMs: null,
        detail: { stage: order.stage, reason: order.reason, legs: legs(journal) },
      }),
    );
  // WORKER_EXECUTE=0. Lifecycle would call chain.prepare, catch "Live execution disabled"
  // and — because no fund leg exists yet — write the order `cancelled` before funding.
  // Budget reservations are never credited back, so an observation-only worker would
  // permanently burn a user's period and lifetime caps for a trade nobody attempted.
  if (!deps.executeEnabled)
    return record(
      deps.log,
      jobResult({
        ...scoped,
        outcome: "blocked",
        code: "execution-disabled",
        retryAfterMs: null,
        detail: { status: order.status, stage: order.stage },
      }),
    );

  let holder: Awaited<ReturnType<typeof signerHolder>>;
  try {
    holder = await signerHolder(deps, executionId);
  } catch (error) {
    rethrowFatal(error);
    return record(deps.log, jobResult({ ...scoped, outcome: "failed", ...classify(error) }));
  }
  // One dedicated signer serves every owner, so an unrelated in-flight transaction is not
  // merely a queue conflict. `chain.prepare` compares the signer's latest and pending nonce
  // and throws RecoveryRequired("Signer has an unknown pending transaction") when they
  // differ; for a fund leg Lifecycle turns that into `recovery_required` and HALTS this
  // user's instance. Without this gate, one owner's ordinary in-flight swap would push
  // another owner's untouched order into operator recovery.
  if (holder)
    return record(
      deps.log,
      jobResult({
        ...scoped,
        outcome: "blocked",
        code: "signer-busy",
        // A pending leg clears on a receipt; a recovering one needs a person.
        retryAfterMs: holder.status === "pending" ? RETRY.receipt : null,
        detail: { blockingStatus: holder.status },
      }),
    );

  try {
    // Exactly one leg advances per call. Lifecycle is the only writer of order status;
    // this handler never sets one itself, so there is a single place where the order state
    // machine is decided even when a job fails halfway.
    await deps.lifecycle.run(order);
  } catch (error) {
    rethrowFatal(error);
    // `chain.broadcast` is called outside Lifecycle's own try/catch, so an RPC outage or a
    // tampered journal row (RecoveryRequired) escapes here with the order still `pending`
    // and its bytes still durable. Retrying rebroadcasts the same bytes; that is case 2 of
    // the idempotency note. If the RPC never recovers, WORKER_RECEIPT_TIMEOUT_MS
    // (30 minutes by default) eventually moves the order to `recovery_required`.
    return record(deps.log, jobResult({ ...scoped, outcome: "failed", ...classify(error) }));
  }

  let after: Awaited<ReturnType<typeof load>>;
  try {
    after = await load(deps, userId, executionId);
  } catch (error) {
    rethrowFatal(error);
    // The leg itself already committed or not; only the report is missing. A retry is safe.
    return record(deps.log, jobResult({ ...scoped, outcome: "failed", ...classify(error) }));
  }
  if (!after)
    return record(
      deps.log,
      jobResult({ ...scoped, outcome: "skipped", code: "order-unavailable" }),
    );

  const signed = after.journal.find((t) => t.status === "signed");
  const detail = {
    status: after.order.status,
    stage: after.order.stage,
    reason: after.order.reason,
    txHash: after.order.txHash,
    // Leg name, settlement status and nonce only. The raw signed transaction never leaves
    // the database, and a hash is public chain metadata rather than an authorisation.
    legs: legs(after.journal),
    signedLeg: signed?.leg ?? null,
    signedNonce: signed?.nonce ?? null,
    signedHash: signed?.hash ?? null,
  };

  if (after.order.status === "recovery_required")
    return record(
      deps.log,
      jobResult({ ...scoped, outcome: "blocked", code: "recovery-required", detail }),
    );
  if (TERMINAL.includes(after.order.status))
    return record(
      deps.log,
      jobResult({ ...scoped, outcome: "applied", code: `order-${after.order.status}`, detail }),
    );
  // Durable progress is a journal row that appeared or a leg whose receipt settled — not
  // the order's `updatedAt`, which also moves for a status write that changed nothing
  // observable. `legs()` is the compact encoding of both, so comparing it detects either.
  if (after.journal.length !== journal.length || legs(after.journal) !== legs(journal))
    return record(
      deps.log,
      jobResult({
        ...scoped,
        outcome: "applied",
        code: after.journal.length !== journal.length ? "leg-signed" : "leg-settled",
        retryAfterMs: RETRY.receipt,
        detail,
      }),
    );
  // Nothing changed durably: the leg is signed and its receipt is not yet observable, so
  // Lifecycle rebroadcast the identical bytes. That is the expected steady state while a
  // transaction waits for WORKER_CONFIRMATIONS blocks.
  return record(
    deps.log,
    jobResult({
      ...scoped,
      outcome: "blocked",
      code: "awaiting-receipt",
      retryAfterMs: RETRY.receipt,
      detail,
    }),
  );
}

/** `fund:confirmed;approve:signed` — ordered by nonce, so it is stable across reads. */
function legs(journal: readonly { leg: string; status: string }[]) {
  return journal.map((t) => `${t.leg}:${t.status}`).join(";");
}

async function load(deps: JobDependencies, userId: string, executionId: string) {
  return tenant(deps.store.db, userId, async (tx) => {
    const [order] = await tx
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.id, executionId))
      .limit(1);
    // Row-level security scopes this to `userId`, so a payload naming another owner's
    // order reads nothing rather than acting on it.
    if (!order) return undefined;
    const journal = await tx
      .select({
        leg: schema.transactions.leg,
        status: schema.transactions.status,
        nonce: schema.transactions.nonce,
        hash: schema.transactions.hash,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.executionId, executionId))
      .orderBy(asc(schema.transactions.nonce));
    return { order, journal };
  });
}

/**
 * Find any OTHER order that currently owns the signer, across every owner.
 *
 * Row-level security ties each read to one `mandate.user_id`, so there is no single query
 * that spans owners; this pages `users` (which carries no tenant policy, exactly as
 * `WorkerStore.owners` does) and asks inside each owner's context. The scan costs one
 * round trip per owner in the worst case — the same shape and cost as
 * `WorkerStore.activeExecution`, which the worker already runs every 2 s poll. It short
 * circuits on the first holder found, and only runs for an order that is otherwise ready
 * to advance.
 *
 * `WorkerStore.owners()` is deliberately NOT used: its cursor lives on the shared store
 * instance that worker.ts's scheduling loop also advances, so borrowing it would skip a
 * page of owners for that loop and silently stop those users from ticking. The cursor here
 * is local. `recovery/owners.ts` has the same walk with a `maxOwners` bound; the two should
 * collapse into one `WorkerStore.signerHolder()` once the database package can take it.
 */
async function signerHolder(deps: JobDependencies, executionId: string) {
  let cursor: string | undefined;
  for (;;) {
    const owners = await deps.store.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(cursor ? gt(schema.users.id, cursor) : undefined)
      .orderBy(asc(schema.users.id))
      .limit(OWNER_PAGE);
    for (const owner of owners) {
      const holder = await tenant(deps.store.db, owner.id, (tx) => holding(tx, executionId));
      if (holder) return holder;
    }
    if (owners.length < OWNER_PAGE) return undefined;
    cursor = owners.at(-1)?.id;
  }
}

async function holding(tx: Transaction, executionId: string) {
  const [row] = await tx
    .select({ id: schema.executions.id, status: schema.executions.status })
    .from(schema.executions)
    .where(
      and(
        inArray(schema.executions.status, [...HOLDS_SIGNER]),
        ne(schema.executions.id, executionId),
      ),
    )
    .orderBy(asc(schema.executions.createdAt), asc(schema.executions.id))
    .limit(1);
  return row;
}
