import { sql } from "drizzle-orm";
import type { Transaction } from "../client.js";
import type { Attempt, Executor, TransactionOptions } from "./unit.js";
import { isTransaction, withTransaction } from "./unit.js";

/** Every tenant policy reads this setting; it is the whole of the RLS identity. */
export const TENANT_SETTING = "mandate.user_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Run a unit of work as one user, with retry.
 *
 * This is `tenant()` from ../client.ts with the two properties a unit of work needs: the
 * isolation level is explicit, and a serialization failure is retried.
 *
 * `set_config(..., true)` is transaction-local, so it has to be reissued inside *every*
 * attempt. Hoisting it above the retry loop would leave the second attempt running with no
 * tenant context, and RLS would then answer every query with zero rows — a silent "not found"
 * on a strategy the user owns, appearing only under contention. Setting it as the first
 * statement of the transaction also means it is committed or discarded with the work.
 *
 * The id is checked against a UUID shape before it reaches SQL. It is already parameterised, so
 * this is not an injection guard; it is there because the policy casts the setting with
 * `::uuid` and a malformed value raises 22P02 from whichever query happens to run first, which
 * surfaces as an opaque 500 rather than "you passed a bad user id".
 */
export async function withTenant<T>(
  executor: Executor,
  userId: string,
  options: TransactionOptions,
  run: (tx: Transaction, attempt: Attempt) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) throw new Error("Tenant context requires an application user id");
  if (isTransaction(executor)) {
    await adoptTenant(executor, userId);
    return withTransaction(executor, options, run);
  }
  return withTransaction(executor, options, async (tx, attempt) => {
    await tx.execute(sql`select set_config(${TENANT_SETTING}, ${userId}, true)`);
    return run(tx, attempt);
  });
}

/**
 * Join a transaction that already has a tenant, or claim one that does not.
 *
 * Silently overwriting the setting is the failure this prevents. A unit nested inside another
 * user's transaction would start reading and writing that user's rows with RLS satisfied and no
 * error anywhere — the exact cross-tenant leak the policies exist to stop. Cross-tenant work is
 * a real thing the worker does, but it does it by opening a separate transaction per owner
 * (`WorkerStore.write`), never by re-pointing an open one.
 *
 * An unset context is claimed rather than rejected, so a unit composes inside a plain
 * `withTransaction` block. The claim is still transaction-local and unwinds with a rollback to
 * savepoint, so it cannot outlive the work that made it.
 */
async function adoptTenant(tx: Transaction, userId: string) {
  const result = await tx.execute<{ current: string | null }>(
    sql`select nullif(current_setting(${TENANT_SETTING}, true), '') as current`,
  );
  const current = result.rows[0]?.current ?? null;
  if (current === null) {
    await tx.execute(sql`select set_config(${TENANT_SETTING}, ${userId}, true)`);
    return;
  }
  if (current.toLowerCase() !== userId.toLowerCase())
    throw new Error("Refusing to change the tenant of an open transaction");
}
