import { Problem } from "../../packages/contracts/src/index.js";

/**
 * The slice of a PostgreSQL session this tool needs.
 *
 * Deliberately narrow: `node-postgres`, a pooled client and PGlite all satisfy it, so the
 * apply and rollback paths are exercised in tests against the real `mandate_v2` DDL without
 * a server. It is `query` only — no `transaction` helper — because the transaction boundary
 * is written out longhand below where it can be read.
 *
 * CRITICAL: whatever is passed here must be ONE session, not a pool. `begin` issued on a
 * pool takes a connection from it, and the next statement may well land on a different
 * connection outside that transaction — so the migration would appear to run in a
 * transaction and roll back nothing. Callers get a client with `pool.connect()`.
 */
export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

/**
 * Run `work` inside one transaction.
 *
 * The rollback is swallowed on purpose: if the connection died, `rollback` fails too, and
 * throwing that would replace the real cause ("duplicate key on drafts.artifact_id") with a
 * meaningless "connection terminated" — which is how an operator ends up debugging the wrong
 * failure at 3am. The server aborts the transaction when the connection drops anyway.
 */
export async function withTransaction<T>(
  client: SqlClient,
  work: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Adopt a tenant for the statements in `work`.
 *
 * Every table this tool writes carries `FORCE ROW LEVEL SECURITY` with a `WITH CHECK` on
 * `current_setting('mandate.user_id')`, and the migration runs as the schema owner, who is
 * bound by it like anyone else. That is a feature here rather than an obstacle: a bug that
 * paired one user's draft with another user's id cannot write the row at all, it raises
 * 42501. The alternative — running the import with `BYPASSRLS` — would turn that guarantee
 * off during precisely the operation most likely to mix tenants up.
 *
 * `set_config(..., true)` is transaction-local, so the setting unwinds with the surrounding
 * transaction and cannot leak onto the next user's statements on a reused connection.
 */
export async function asTenant<T>(
  tx: SqlClient,
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  await tx.query("select set_config('mandate.user_id', $1, true)", [userId]);
  try {
    return await work();
  } finally {
    await tx.query("select set_config('mandate.user_id', '', true)").catch(() => undefined);
  }
}

/**
 * Make a session physically unable to write.
 *
 * The legacy database is still the system of record for the Rust deployment while this runs.
 * A read-only transaction default means a stray `update` in this tool is a 25006 from the
 * server rather than a silent corruption of production data that nobody notices until the
 * cutover. Cheaper than reviewing every statement, and it also holds for statements added
 * later by someone who did not read this comment.
 */
export async function makeSessionReadOnly(client: SqlClient): Promise<void> {
  await client.query("set session characteristics as transaction read only");
}

/**
 * Raise the statement timeout for the migration session.
 *
 * `connectDatabase` pins `statement_timeout` to 10s, which is right for an HTTP handler and
 * wrong for a bulk read over a legacy database: a scan that takes twelve seconds would abort
 * the whole run with a timeout that reads like a database fault. Still bounded, and bounded
 * low enough to matter — an unbounded statement inside a transaction holding row locks on
 * `mandate_v2` is its own outage.
 */
export async function widenStatementTimeout(client: SqlClient, ms = 600_000): Promise<void> {
  if (!Number.isInteger(ms) || ms < 1000 || ms > 3_600_000)
    throw new Problem(
      400,
      "invalid-timeout",
      "Invalid statement timeout",
      "The migration statement timeout must be between 1000 and 3600000 milliseconds.",
    );
  await client.query(`set statement_timeout = ${ms}`);
}

/** Exactly one row, or a failure that names the query instead of returning `undefined`. */
export async function one<Row extends Record<string, unknown>>(
  client: SqlClient,
  text: string,
  params: readonly unknown[],
  subject: string,
): Promise<Row> {
  const { rows } = await client.query<Row>(text, params);
  const row = rows[0];
  if (!row || rows.length !== 1)
    throw new Problem(
      500,
      "migration-query",
      "Unexpected query result",
      `Expected exactly one ${subject} row, received ${rows.length}.`,
    );
  return row;
}
