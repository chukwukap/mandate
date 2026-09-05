import { Problem } from "../../packages/contracts/src/index.js";
import type { SqlClient } from "./sql.js";

/**
 * The record of what an import actually wrote, written by the import itself.
 *
 * A rollback that works out what to delete by re-deriving the plan is a rollback nobody
 * should trust: it deletes what the tool BELIEVES it wrote, from a legacy database that may
 * have changed, using a catalogue that may have changed, with an operator's `--slippage-bps`
 * they may not remember. This journal removes the derivation. Every row this tool inserts is
 * recorded by primary key in the SAME transaction that inserts it, so the journal cannot
 * describe a row that does not exist and cannot miss a row that does.
 *
 * It lives in its own `mandate_migration` schema rather than in `mandate_v2`, for three
 * reasons. Drizzle owns `mandate_v2` and would want to drop anything it did not generate.
 * `databaseReady` probes named columns of the application tables, so an extra table there is
 * a needless way to fail a readiness check. And the application role is granted only
 * `mandate_v2`, so the running API physically cannot read or rewrite the migration's audit
 * trail — which is the point of having one.
 */

export const JOURNAL_SCHEMA = "mandate_migration";

/** Bumped only when the DDL below changes shape. Recorded on every run. */
export const JOURNAL_VERSION = 1;

export type RunStatus = "applied" | "rolled_back" | "partially_rolled_back";

export type ImportedEntity = "user" | "draft";

export type ImportedRow = {
  readonly entity: ImportedEntity;
  /** The `mandate_v2` primary key this run inserted. */
  readonly rowId: string;
  /** The tenant the row belongs to. Deleting it needs this to adopt the right RLS context. */
  readonly userId: string;
  /** Where it came from in the legacy database, so a human can go and look. */
  readonly legacyRef: string;
  /** `artifact_id` for a draft, `privy_did` for a user. Proves the row is still ours. */
  readonly fingerprint: string;
};

export type JournalRun = {
  readonly id: string;
  readonly status: RunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly rolledBackAt: Date | undefined;
  readonly source: string;
  readonly toolVersion: string;
  readonly summary: Record<string, unknown>;
};

/**
 * Create the journal if it is not there.
 *
 * Called inside the import's transaction. PostgreSQL runs DDL transactionally, so a run that
 * fails halfway leaves neither the journal nor the rows it would have described — the two
 * cannot get out of step even on the very first run.
 *
 * `if not exists` throughout rather than a migration sequence: this schema is written by one
 * tool, read by the same tool, and never by the application. A second migrations framework
 * for four tables would be more moving parts than the thing it manages.
 */
export async function ensureJournal(tx: SqlClient): Promise<void> {
  await tx.query(`create schema if not exists ${JOURNAL_SCHEMA}`);
  await tx.query(`create table if not exists ${JOURNAL_SCHEMA}.runs (
      id uuid primary key,
      journal_version integer not null,
      tool_version text not null,
      source text not null,
      started_at timestamp (3) with time zone not null,
      finished_at timestamp (3) with time zone not null,
      status text not null,
      options jsonb not null,
      summary jsonb not null,
      rolled_back_at timestamp (3) with time zone,
      constraint run_status_valid check (status in ('applied','rolled_back','partially_rolled_back')),
      constraint run_rollback_dated check ((status = 'applied') = (rolled_back_at is null))
    )`);
  // No foreign key from `imports.user_id` to `mandate_v2.users`: rolling a run back deletes
  // the user it created, and the journal must survive that deletion. An audit trail that is
  // erased by the operation it audits is not an audit trail.
  await tx.query(`create table if not exists ${JOURNAL_SCHEMA}.imports (
      run_id uuid not null references ${JOURNAL_SCHEMA}.runs(id),
      entity text not null,
      row_id uuid not null,
      user_id uuid not null,
      legacy_ref text not null,
      fingerprint text not null,
      removed_at timestamp (3) with time zone,
      retained_reason text,
      primary key (run_id, entity, row_id),
      constraint import_entity_valid check (entity in ('user','draft')),
      constraint import_outcome_exclusive check (removed_at is null or retained_reason is null)
    )`);
  await tx.query(
    `create index if not exists imports_row_idx on ${JOURNAL_SCHEMA}.imports (entity, row_id)`,
  );
}

/**
 * Is the journal present and readable?
 *
 * Used by the rollback path before it claims a run id does not exist. "No such run" and "no
 * journal at all" are different operator situations — the second means they are pointed at
 * the wrong database — and reporting the first for the second sends them looking for a run
 * id in a database that never had one.
 */
export async function journalPresent(client: SqlClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `select to_regclass('${JOURNAL_SCHEMA}.runs') is not null as present`,
  );
  return rows[0]?.present === true;
}

export async function recordRun(
  tx: SqlClient,
  run: {
    readonly id: string;
    readonly toolVersion: string;
    readonly source: string;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly options: Record<string, unknown>;
    readonly summary: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `insert into ${JOURNAL_SCHEMA}.runs
       (id, journal_version, tool_version, source, started_at, finished_at, status, options, summary)
     values ($1, $2, $3, $4, $5, $6, 'applied', $7, $8)`,
    [
      run.id,
      JOURNAL_VERSION,
      run.toolVersion,
      run.source,
      run.startedAt,
      run.finishedAt,
      JSON.stringify(run.options),
      JSON.stringify(run.summary),
    ],
  );
}

/**
 * Record the rows one run inserted.
 *
 * Written as a single multi-row insert. Not for speed — for atomicity of intent: there is no
 * window in which half the journal exists, because there is no second statement.
 */
export async function recordImports(
  tx: SqlClient,
  runId: string,
  rows: readonly ImportedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [runId];
  const tuples = rows.map((row) => {
    const base = values.length;
    values.push(row.entity, row.rowId, row.userId, row.legacyRef, row.fingerprint);
    return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });
  await tx.query(
    `insert into ${JOURNAL_SCHEMA}.imports (run_id, entity, row_id, user_id, legacy_ref, fingerprint)
     values ${tuples.join(", ")}`,
    values,
  );
}

/**
 * Read one run and take a row lock on it.
 *
 * `for update` is what stops two operators rolling the same run back at once. Without it both
 * would read `status = 'applied'`, both would find the drafts, and the second would delete
 * nothing while reporting a successful rollback — an outcome that looks identical to the
 * first one and tells the second operator that the rows they are still looking at are gone.
 */
export async function lockRun(tx: SqlClient, runId: string): Promise<JournalRun> {
  const { rows } = await tx.query<{
    id: string;
    status: string;
    started_at: Date;
    finished_at: Date;
    rolled_back_at: Date | null;
    source: string;
    tool_version: string;
    summary: Record<string, unknown>;
  }>(
    `select id, status, started_at, finished_at, rolled_back_at, source, tool_version, summary
       from ${JOURNAL_SCHEMA}.runs where id = $1 for update`,
    [runId],
  );
  const row = rows[0];
  if (!row)
    throw new Problem(
      404,
      "unknown-run",
      "No such migration run",
      `The journal in this database holds no run ${runId}. Check the run id and that this is the database the import was applied to.`,
    );
  return {
    id: row.id,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    rolledBackAt: row.rolled_back_at ?? undefined,
    source: row.source,
    toolVersion: row.tool_version,
    summary: row.summary,
  };
}

export async function readImports(
  tx: SqlClient,
  runId: string,
): Promise<readonly (ImportedRow & { readonly removedAt: Date | undefined })[]> {
  const { rows } = await tx.query<{
    entity: string;
    row_id: string;
    user_id: string;
    legacy_ref: string;
    fingerprint: string;
    removed_at: Date | null;
  }>(
    `select entity, row_id, user_id, legacy_ref, fingerprint, removed_at
       from ${JOURNAL_SCHEMA}.imports where run_id = $1 order by entity, row_id`,
    [runId],
  );
  return rows.map((row) => ({
    entity: row.entity as ImportedEntity,
    rowId: row.row_id,
    userId: row.user_id,
    legacyRef: row.legacy_ref,
    fingerprint: row.fingerprint,
    removedAt: row.removed_at ?? undefined,
  }));
}

export async function markRemoved(
  tx: SqlClient,
  runId: string,
  entity: ImportedEntity,
  rowId: string,
  at: Date,
): Promise<void> {
  await tx.query(
    `update ${JOURNAL_SCHEMA}.imports
        set removed_at = $4, retained_reason = null
      where run_id = $1 and entity = $2 and row_id = $3`,
    [runId, entity, rowId, at],
  );
}

export async function markRetained(
  tx: SqlClient,
  runId: string,
  entity: ImportedEntity,
  rowId: string,
  reason: string,
): Promise<void> {
  await tx.query(
    `update ${JOURNAL_SCHEMA}.imports
        set retained_reason = $4, removed_at = null
      where run_id = $1 and entity = $2 and row_id = $3`,
    [runId, entity, rowId, reason],
  );
}

export async function closeRun(
  tx: SqlClient,
  runId: string,
  status: Exclude<RunStatus, "applied">,
  at: Date,
  summary: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `update ${JOURNAL_SCHEMA}.runs set status = $2, rolled_back_at = $3, summary = $4 where id = $1`,
    [runId, status, at, JSON.stringify(summary)],
  );
}

/** Every run, newest first. What `migrate runs` prints and what a rollback needs to pick from. */
export async function listRuns(client: SqlClient, limit = 50): Promise<readonly JournalRun[]> {
  if (!(await journalPresent(client))) return [];
  const { rows } = await client.query<{
    id: string;
    status: string;
    started_at: Date;
    finished_at: Date;
    rolled_back_at: Date | null;
    source: string;
    tool_version: string;
    summary: Record<string, unknown>;
  }>(
    `select id, status, started_at, finished_at, rolled_back_at, source, tool_version, summary
       from ${JOURNAL_SCHEMA}.runs order by finished_at desc limit $1`,
    [Math.max(1, Math.min(limit, 500))],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    rolledBackAt: row.rolled_back_at ?? undefined,
    source: row.source,
    toolVersion: row.tool_version,
    summary: row.summary,
  }));
}
