import { Problem } from "@mandate/contracts";

/**
 * SQLSTATE classification for the transaction runner.
 *
 * Everything here answers one question: is it safe to run this unit of work again? "Safe"
 * means two things at once — the failed attempt definitely left nothing behind, and running
 * the body a second time cannot produce a second side effect. PostgreSQL only tells us the
 * first half; the second half is the caller's contract, documented on `withTransaction`.
 */

/** Two transactions touched the same rows under repeatable read or serializable. */
export const SERIALIZATION_FAILURE = "40001";
/** The deadlock detector picked this transaction as the victim; the other one committed. */
export const DEADLOCK_DETECTED = "40P01";
/** A `FOR UPDATE NOWAIT` / `SKIP LOCKED` conflict. Not used today, retried if it appears. */
export const LOCK_NOT_AVAILABLE = "55P03";
/** A unique constraint. Never retried: it is a real conflict and several units rely on it. */
export const UNIQUE_VIOLATION = "23505";
/** `statement_timeout` fired. The transaction rolled back, but a retry usually times out too. */
export const QUERY_CANCELED = "57014";
/** A statement issued after an error inside the same transaction. Always a caller bug. */
export const IN_FAILED_TRANSACTION = "25P02";

/**
 * The only codes worth another attempt.
 *
 * Deliberately excluded, each for its own reason:
 *
 * - Connection loss (`08006`, `08003`, `57P01`, `57P02`). The transaction may have committed
 *   before the socket died — PostgreSQL has no way to tell us which side of COMMIT it fell on.
 *   Retrying a commit of unknown outcome is how one signed swap becomes two.
 * - `57014` (statement_timeout). The pool sets a 10s statement timeout; a query that hit it
 *   will hit it again, and the retry only burns the request's remaining budget.
 * - `23505` (unique violation). `writeExecutionLeg` uses `execution_leg` and `signer_nonce`
 *   as idempotency keys, so this code is an answer, not a failure.
 * - `23514` / `23503` (check and foreign key). Deterministic; a retry reproduces them exactly.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  SERIALIZATION_FAILURE,
  DEADLOCK_DETECTED,
  LOCK_NOT_AVAILABLE,
]);

/**
 * Pull the SQLSTATE out of whatever drizzle threw.
 *
 * drizzle wraps every driver error in `DrizzleQueryError`, so `error.code` is empty at the top
 * level and the pg error hangs off `cause`. The wrapper's own `message` interpolates the SQL
 * text *and the bound parameters* — spend caps, wallet addresses, and on the permission path a
 * signature — which is exactly why this function returns a five-character code and nothing
 * else. Callers get a classification, never an object that would leak a row into a log line.
 *
 * The chain is walked with a depth bound rather than a `seen` set: a self-referential `cause`
 * is conceivable from a badly behaved driver and an unbounded walk would hang the process.
 */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    // pg reports SQLSTATE as five characters. Node's own errors ("ECONNRESET", "ERR_*") also
    // populate `code`, and treating one of those as a SQLSTATE would misclassify a dead socket.
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Should this failure be attempted again?
 *
 * A `Problem` is never retried even if something retryable is buried in its cause chain: a
 * Problem is a decision the code made on purpose ("this draft is already consumed"), and
 * repeating it just spends the retry budget arriving at the same refusal.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Problem) return false;
  const code = sqlState(error);
  return code !== undefined && RETRYABLE_CODES.has(code);
}

/** True for a unique violation, optionally narrowed to one named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (sqlState(error) !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    if ((current as { constraint?: unknown }).constraint === constraint) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A unit of work that kept losing to a concurrent writer.
 *
 * It extends `Problem` so the API's RFC7807 handler renders it without any extra wiring, and
 * it is a 503 rather than a 409: nothing about the request is wrong, the row was simply busy,
 * and the correct client behaviour is to retry the same request. The original driver error is
 * intentionally *not* attached as `cause` — see `sqlState` — so only the SQLSTATE, the attempt
 * count and the elapsed time survive, which is everything an operator actually needs.
 */
export class WriteConflict extends Problem {
  constructor(
    readonly attempts: number,
    readonly sqlState: string,
    readonly elapsedMs: number,
  ) {
    super(
      503,
      "write-conflict",
      "Write conflict",
      "Another change to this strategy was being written at the same time. Try again.",
    );
  }
}
