import { Problem } from "../../packages/contracts/src/index.js";
import type { JournalRun, RunStatus } from "./journal.js";
import {
  closeRun,
  journalPresent,
  lockRun,
  markRemoved,
  markRetained,
  readImports,
} from "./journal.js";
import type { SqlClient } from "./sql.js";
import { asTenant, withTransaction } from "./sql.js";

/**
 * Undo one applied run.
 *
 * A migration nobody can undo is a migration nobody will run, so this is not an afterthought
 * bolted on to the import — it is the reason the import journals every row it writes. Rollback
 * never re-derives anything: it reads the journal, deletes exactly those primary keys, and
 * records for each one whether it went or why it stayed.
 *
 * The one thing it will not do is destroy authority the user granted AFTER the migration. A
 * migrated draft that has since been signed is now the provenance of a live instance and a
 * spend permission over real money; the correct answer to "roll back the migration" in that
 * case is "that draft stays, and here is the list", not a cascading delete. The row is
 * retained, the reason is journalled, and the run is closed as partially rolled back.
 *
 * `strict` inverts the trade for operators who need all-or-nothing: anything that must be
 * retained aborts the transaction, so nothing at all is deleted and the database is untouched.
 */

export type RollbackOptions = {
  readonly now: Date;
  /** Abort — deleting nothing — if any journalled row cannot be removed. */
  readonly strict?: boolean | undefined;
};

export type Retention = {
  readonly entity: "user" | "draft";
  readonly rowId: string;
  readonly legacyRef: string;
  readonly reason: string;
};

export type RollbackResult = {
  readonly runId: string;
  readonly status: Exclude<RunStatus, "applied">;
  readonly draftsRemoved: number;
  readonly usersRemoved: number;
  /** Rows the journal claims but the database no longer has. Counted, not an error. */
  readonly alreadyGone: number;
  readonly retained: readonly Retention[];
};

/** Tables that make a migrated user's tenancy non-empty, and so make deleting them wrong. */
const TENANT_TABLES = [
  "drafts",
  "instances",
  "permissions",
  "evaluations",
  "executions",
  "transactions",
] as const;

export async function rollbackMigration(
  client: SqlClient,
  runId: string,
  options: RollbackOptions,
): Promise<RollbackResult> {
  if (!(await journalPresent(client)))
    throw new Problem(
      404,
      "no-journal",
      "No migration journal in this database",
      "This database has no mandate_migration schema, so nothing was ever imported into it by this tool. Check the connection target.",
    );

  const retained: Retention[] = [];
  let draftsRemoved = 0;
  let usersRemoved = 0;
  let alreadyGone = 0;

  const status = await withTransaction(client, async (tx) => {
    const run = await lockRun(tx, runId);
    assertRollbackable(run);
    const imports = await readImports(tx, runId);
    const drafts = imports.filter((row) => row.entity === "draft");
    const users = imports.filter((row) => row.entity === "user");

    for (const [userId, owned] of groupByUser(drafts)) {
      await asTenant(tx, userId, async () => {
        for (const draft of owned) {
          const outcome = await removeDraft(tx, draft.rowId, draft.fingerprint);
          if (outcome === "removed") {
            draftsRemoved += 1;
            await markRemoved(tx, runId, "draft", draft.rowId, options.now);
          } else if (outcome === "absent") {
            alreadyGone += 1;
            await markRemoved(tx, runId, "draft", draft.rowId, options.now);
          } else {
            retained.push({
              entity: "draft",
              rowId: draft.rowId,
              legacyRef: draft.legacyRef,
              reason: outcome.reason,
            });
            await markRetained(tx, runId, "draft", draft.rowId, outcome.reason);
          }
        }
      });
    }

    // Users last: a user cannot be removed while any of their rows survive, and the drafts
    // above are the rows most likely to have survived.
    for (const user of users) {
      const outcome = await removeUser(tx, user.rowId, user.fingerprint);
      if (outcome === "removed") {
        usersRemoved += 1;
        await markRemoved(tx, runId, "user", user.rowId, options.now);
      } else if (outcome === "absent") {
        alreadyGone += 1;
        await markRemoved(tx, runId, "user", user.rowId, options.now);
      } else {
        retained.push({
          entity: "user",
          rowId: user.rowId,
          legacyRef: user.legacyRef,
          reason: outcome.reason,
        });
        await markRetained(tx, runId, "user", user.rowId, outcome.reason);
      }
    }

    const closed: Exclude<RunStatus, "applied"> =
      retained.length === 0 ? "rolled_back" : "partially_rolled_back";
    if (options.strict && retained.length > 0)
      throw new Problem(
        409,
        "rollback-incomplete",
        "Rollback would leave rows behind",
        `${retained.length} journalled row(s) cannot be removed: ${retained
          .slice(0, 5)
          .map((row) => `${row.rowId} (${row.reason})`)
          .join("; ")}. Nothing was deleted. Re-run without --strict to remove the rest and keep these.`,
      );
    await closeRun(tx, runId, closed, options.now, {
      drafts_removed: draftsRemoved,
      users_removed: usersRemoved,
      already_gone: alreadyGone,
      retained: retained.length,
    });
    return closed;
  });

  return { runId, status, draftsRemoved, usersRemoved, alreadyGone, retained };
}

function assertRollbackable(run: JournalRun): void {
  if (run.status === "applied") return;
  throw new Problem(
    409,
    "already-rolled-back",
    "This run was already rolled back",
    `Run ${run.id} is ${run.status} as of ${run.rolledBackAt?.toISOString() ?? "an unrecorded time"}. Rolling it back again would delete rows a later run owns.`,
  );
}

type Removal = "removed" | "absent" | { readonly reason: string };

/**
 * Delete one migrated draft, if it is still only a draft.
 *
 * The guards are inside the `delete` rather than in a read-then-delete for a reason that
 * costs money to get wrong: a foreign key violation inside this transaction would abort the
 * whole rollback, and PostgreSQL gives no way to continue past it. `consumed_at is null` and
 * `not exists (... instances ...)` mean the statement simply matches nothing when the draft
 * has been signed, and the reason is then established by a read that cannot fail.
 *
 * The fingerprint check is what makes the delete safe to repeat. The journal names an id; the
 * `artifact_id` proves the row at that id is still the row this run wrote, and not something
 * that reused the id after an earlier rollback removed it.
 */
async function removeDraft(tx: SqlClient, id: string, artifactId: string): Promise<Removal> {
  const { rows } = await tx.query<{ id: string }>(
    `delete from mandate_v2.drafts d
      where d.id = $1 and d.artifact_id = $2 and d.consumed_at is null
        and not exists (select 1 from mandate_v2.instances i where i.draft_id = d.id)
      returning d.id`,
    [id, artifactId],
  );
  if (rows.length === 1) return "removed";
  const { rows: found } = await tx.query<{
    artifact_id: string;
    consumed: boolean;
    armed: boolean;
  }>(
    `select d.artifact_id,
            d.consumed_at is not null as consumed,
            exists (select 1 from mandate_v2.instances i where i.draft_id = d.id) as armed
       from mandate_v2.drafts d where d.id = $1`,
    [id],
  );
  const row = found[0];
  if (!row) return "absent";
  if (row.artifact_id !== artifactId)
    return {
      reason: `the draft at this id now holds artifact ${row.artifact_id}, not the ${artifactId} this run wrote`,
    };
  if (row.armed)
    return { reason: "the user has signed it and it is the provenance of a live instance" };
  if (row.consumed) return { reason: "the user has already consumed it" };
  return { reason: "the delete matched no row for a reason this tool cannot establish" };
}

/**
 * Delete a user this run created, if the run is the only thing they have here.
 *
 * The emptiness check runs under the user's own tenant adoption because every table it counts
 * forces row-level security: an unadopted count returns zero from all six and would report a
 * busy account as empty, which is the one mistake here that deletes a real person's tenancy.
 */
async function removeUser(tx: SqlClient, id: string, privyDid: string): Promise<Removal> {
  const { rows: found } = await tx.query<{ privy_did: string }>(
    "select privy_did from mandate_v2.users where id = $1",
    [id],
  );
  const row = found[0];
  if (!row) return "absent";
  if (row.privy_did !== privyDid)
    return { reason: `the user at this id is now ${row.privy_did}, not the ${privyDid} this run created` };
  const owned = await asTenant(tx, id, async () => {
    for (const table of TENANT_TABLES) {
      const { rows } = await tx.query<{ present: boolean }>(
        `select exists (select 1 from mandate_v2.${table} where user_id = $1) as present`,
        [id],
      );
      if (rows[0]?.present === true) return table;
    }
    return undefined;
  });
  if (owned) return { reason: `the account still owns rows in ${owned}` };
  const { rows } = await tx.query<{ id: string }>(
    "delete from mandate_v2.users where id = $1 returning id",
    [id],
  );
  return rows.length === 1 ? "removed" : { reason: "the delete was refused by the database" };
}

function groupByUser<T extends { readonly userId: string }>(rows: readonly T[]) {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push(row);
    out.set(row.userId, list);
  }
  return out;
}
