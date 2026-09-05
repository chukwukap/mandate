import { sql } from "drizzle-orm";
import type { Database, Transaction } from "../client.js";
import { isRetryable, sqlState, WriteConflict } from "./errors.js";

/**
 * Either end of a unit of work: the pool, or a transaction already in progress.
 *
 * Repositories take this rather than `Database` so a unit composes. `Repository.locked` opens a
 * transaction and hands the `tx` down; a unit called with that `tx` joins the caller's atom
 * instead of opening a second connection and deadlocking against the row the caller just
 * locked.
 */
export type Executor = Database | Transaction;

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

/**
 * PostgreSQL's four levels, ranked. `read uncommitted` is accepted by the server and silently
 * behaves as `read committed`, so it is ranked alongside it rather than below it — a nested
 * unit asking for `read committed` inside a `read uncommitted` parent is not being downgraded.
 */
const STRENGTH: Record<string, number> = {
  "read uncommitted": 1,
  "read committed": 1,
  "repeatable read": 2,
  serializable: 3,
};

export type Attempt = {
  /** 1 for the first try. */
  readonly number: number;
  /** Unix ms when `withTransaction` was entered, not when this attempt began. */
  readonly startedAt: number;
  /** SQLSTATE that caused the previous attempt to be abandoned, if any. */
  readonly previousFailure?: string | undefined;
};

export type TransactionOptions = {
  readonly isolationLevel?: IsolationLevel | undefined;
  readonly accessMode?: "read only" | "read write" | undefined;
  readonly deferrable?: boolean | undefined;
  /** Total attempts including the first. 1 disables retry. */
  readonly maxAttempts?: number | undefined;
  /** Give up rather than start another attempt once this much wall time has passed. */
  readonly deadlineMs?: number | undefined;
  /** Milliseconds to wait before attempt `n` (n >= 2). Injected so tests need no real sleep. */
  readonly backoffMs?: ((attempt: number) => number) | undefined;
  /** Called before each retry. Deliberately given a code, never the driver error. */
  readonly onRetry?: ((info: { attempt: number; sqlState: string }) => void) | undefined;
};

/**
 * Three attempts, not ten.
 *
 * A serialization failure means someone else won the same rows. Two extra attempts clear the
 * ordinary case — a user's second browser tab, or the worker's evaluation landing on the row an
 * API call is updating — while a strategy under sustained contention gets a 503 quickly instead
 * of holding a connection out of a pool that only has twelve.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Stop starting attempts after five seconds.
 *
 * The pool sets `statement_timeout` to 10s and `connectionTimeoutMillis` to 5s, so a unit that
 * has already burned five seconds of retries is competing with the request's own timeouts. The
 * deadline is checked *before* sleeping, so the caller is never left waiting past it.
 */
export const DEFAULT_DEADLINE_MS = 5_000;

/**
 * Full jitter, 15ms base, 200ms ceiling.
 *
 * Fixed backoff is the wrong shape here: two workers that collide will retry in lockstep and
 * collide again. Randomising the whole interval (rather than adding jitter to a fixed delay)
 * is what actually decorrelates them, and the ceiling keeps the worst case well inside
 * `DEFAULT_DEADLINE_MS` for the full attempt budget.
 */
export function defaultBackoffMs(attempt: number): number {
  const ceiling = Math.min(200, 15 * 2 ** Math.max(0, attempt - 2));
  return Math.floor(Math.random() * ceiling);
}

/** Distinguishes a live transaction from the pool. `PgTransaction` is the only one with it. */
export function isTransaction(executor: Executor): executor is Transaction {
  return typeof (executor as Transaction).rollback === "function";
}

const sleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run a unit of work in one transaction, retrying only what is safe to retry.
 *
 * The contract the caller must hold up: **`run` may execute more than once**. Everything it
 * does must live inside `tx`, or be idempotent. Signing a transaction, charging a fee, calling
 * an RPC that mutates, or pushing onto an array declared outside the closure are all bugs here
 * — the retry would repeat them while the database repeats nothing. Reading the clock inside
 * `run` is fine and usually right; capturing `now` outside and reusing it across attempts is
 * also fine, and is what most callers want so a retry cannot straddle an expiry boundary.
 *
 * When `executor` is already a transaction the body runs inline: no savepoint, no retry, no
 * `SET TRANSACTION`. That is not a limitation, it is the point. A savepoint would let the outer
 * caller catch a failed unit and commit anyway, which is precisely how an `executions` row gets
 * written without its `transactions` row. And a retry inside a failed transaction cannot work
 * at all — every statement after the error returns 25P02 until the outer block unwinds.
 *
 * The nested path still checks one thing: that the ambient isolation level is at least as
 * strong as the one this unit asked for. A unit written for `serializable` silently running
 * under `read committed` is a lost-update bug that only shows up under load, so it fails loudly
 * at the one cheap `current_setting` read instead.
 */
export async function withTransaction<T>(
  executor: Executor,
  options: TransactionOptions,
  run: (tx: Transaction, attempt: Attempt) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  if (isTransaction(executor)) {
    await assertIsolation(executor, options.isolationLevel);
    return run(executor, { number: 1, startedAt });
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  // Keys are omitted rather than set to undefined, and an entirely empty set becomes `undefined`
  // rather than `{}`. drizzle only tests the config for truthiness before emitting the modifier
  // clause, so `{}` renders as a bare `begin ` on node-postgres and as an outright syntax error
  // (`set transaction ` with nothing after it) on the pglite driver the tests run against.
  const modifiers = {
    ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    ...(options.accessMode ? { accessMode: options.accessMode } : {}),
    ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
  };
  const config = Object.keys(modifiers).length > 0 ? modifiers : undefined;

  let previousFailure: string | undefined;
  for (let number = 1; ; number += 1) {
    try {
      const attempt: Attempt = { number, startedAt, previousFailure };
      return await executor.transaction((tx) => run(tx, attempt), config);
    } catch (error) {
      const code = sqlState(error);
      if (!isRetryable(error) || code === undefined) throw error;
      const elapsed = Date.now() - startedAt;
      const delay = backoffMs(number + 1);
      // Both bounds are checked before sleeping. Waiting out a backoff and *then* discovering
      // the budget is spent would add latency to a request that was always going to fail.
      if (number + 1 > maxAttempts || elapsed + delay >= deadlineMs)
        throw new WriteConflict(number, code, elapsed);
      previousFailure = code;
      options.onRetry?.({ attempt: number + 1, sqlState: code });
      await sleep(delay);
    }
  }
}

/**
 * Refuse to run a unit under weaker isolation than it was written for.
 *
 * `transaction_isolation` is a read of the *current* transaction's effective level, which is
 * what matters: the parent may have been opened with an explicit level or inherited the
 * session default, and only the server knows which.
 */
async function assertIsolation(tx: Transaction, required: IsolationLevel | undefined) {
  if (!required) return;
  const result = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  const ambient = result.rows[0]?.level ?? "";
  const have = STRENGTH[ambient];
  const want = STRENGTH[required] ?? 0;
  if (have === undefined || have < want)
    throw new Error(
      `Unit of work requires ${required} isolation but the open transaction is ${ambient || "unknown"}`,
    );
}
