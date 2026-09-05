import { randomUUID } from "node:crypto";
import { Problem } from "../../packages/contracts/src/index.js";
import type { ImportedRow } from "./journal.js";
import { ensureJournal, recordImports, recordRun } from "./journal.js";
import type { MigrationPlan, PlannedDraft, PlannedUser, TargetDirectory } from "./plan.js";
import { planTotals } from "./plan.js";
import type { SqlClient } from "./sql.js";
import { asTenant, withTransaction } from "./sql.js";

/**
 * Write a plan into `mandate_v2`.
 *
 * One transaction for the entire run, including the journal and including the DDL that
 * creates the journal. Not for speed: for the property that there is no such thing as a
 * partially applied migration. Either every user, every draft and the journal describing them
 * are committed together, or the database is exactly as it was and the operator can fix the
 * cause and re-run. A per-user commit would be faster and would produce the one state nobody
 * can reason about — some users migrated, some not, and no record of which.
 *
 * The cost is a long transaction, and it is a real cost: it holds locks and it accumulates
 * WAL. It is affordable here because the writes are inserts into tables the running API only
 * reads per-tenant, and because the whole point of a cutover window is that this is the only
 * thing happening.
 */

export type ApplyOptions = {
  readonly toolVersion: string;
  readonly now: Date;
  /** Supplied by tests so a run id is reproducible. Production always generates one. */
  readonly runId?: string | undefined;
};

export type ApplyResult = {
  readonly runId: string;
  readonly usersCreated: number;
  readonly usersReused: number;
  readonly draftsInserted: number;
  readonly draftsAlreadyPresent: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
};

/** The `drafts` columns, in the order the insert below binds them. */
const DRAFT_COLUMNS = [
  "id",
  "user_id",
  "account",
  "artifact_id",
  "name",
  "mode",
  "plan",
  "envelope",
  "reading",
  "render_text",
  "render_hash",
  "confirm_message",
  "created_at",
  "expires_at",
] as const;

export async function applyMigration(
  client: SqlClient,
  plan: MigrationPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = options.now;
  const imports: ImportedRow[] = [];
  let usersCreated = 0;
  let draftsInserted = 0;
  let draftsAlreadyPresent = 0;

  await withTransaction(client, async (tx) => {
    await ensureJournal(tx);
    for (const user of plan.users) {
      if (await insertUser(tx, user, startedAt)) {
        usersCreated += 1;
        imports.push({
          entity: "user",
          rowId: user.userId,
          userId: user.userId,
          legacyRef: `app_user ${user.legacyUserId}`,
          fingerprint: user.privyDid,
        });
      }
    }
    for (const [userId, drafts] of byTenant(plan.drafts)) {
      // Every draft for one user under one tenant adoption. `set_config(..., true)` is
      // transaction-local, so the context unwinds with this transaction and cannot leak onto
      // the next user's statements — and, more importantly, a draft whose `user_id` does not
      // match the adopted tenant is refused by the table's own WITH CHECK rather than written.
      // Running the import with BYPASSRLS would turn that guarantee off during exactly the
      // operation most likely to mix two tenants up.
      await asTenant(tx, userId, async () => {
        for (const draft of drafts) {
          const outcome = await insertDraft(tx, draft);
          if (outcome === "inserted") {
            draftsInserted += 1;
            imports.push({
              entity: "draft",
              rowId: draft.row.id,
              userId,
              legacyRef: `strategy_version ${draft.legacy.versionId}`,
              fingerprint: draft.row.artifactId,
            });
          } else draftsAlreadyPresent += 1;
        }
      });
    }
    await recordImports(tx, runId, imports);
    await recordRun(tx, {
      id: runId,
      toolVersion: options.toolVersion,
      source: plan.source,
      startedAt,
      finishedAt: new Date(),
      options: plan.options,
      summary: {
        users_created: usersCreated,
        users_reused: plan.users.length - usersCreated,
        drafts_inserted: draftsInserted,
        drafts_already_present: draftsAlreadyPresent,
        refusals: plan.issues.length,
        planned: planTotals(plan),
      },
    });
  });

  return {
    runId,
    usersCreated,
    usersReused: plan.users.length - usersCreated,
    draftsInserted,
    draftsAlreadyPresent,
    startedAt,
    finishedAt: new Date(),
  };
}

/**
 * Create the user row, unless the DID already has one.
 *
 * Returns whether this run created it, because that is what the journal has to know: a
 * rollback may only delete a user this run brought into existence. Deleting a user that
 * already had an account here would take their live login with it.
 *
 * The re-read after the conflict is not paranoia. Between the plan being built and this
 * statement running, the same person can have signed into the new deployment for the first
 * time, which creates their `users` row with a fresh random id — and every draft in this
 * transaction is addressed to the id the PLAN chose. Committing then would file their
 * strategies under a tenancy their login does not resolve to, and the drafts would simply
 * never appear for them. Refusing sends the operator back to `plan`, which is cheap.
 */
async function insertUser(tx: SqlClient, user: PlannedUser, now: Date): Promise<boolean> {
  if (!user.create) {
    // The plan said this DID already has an account and addressed its drafts to that id.
    // Confirm it is still true here rather than discovering it as a foreign key violation
    // fifty drafts later, where the error names a constraint instead of a person.
    const { rows } = await tx.query<{ id: string }>(
      "select id from mandate_v2.users where privy_did = $1",
      [user.privyDid],
    );
    if (rows[0]?.id !== user.userId)
      throw new Problem(
        409,
        "user-conflict",
        "The target changed since the plan was built",
        `The plan attaches this user's drafts to ${user.userId} for ${user.privyDid}, which is no longer that account's id here. Re-run plan before applying.`,
      );
    return false;
  }
  const { rows } = await tx.query<{ id: string }>(
    `insert into mandate_v2.users (id, privy_did, created_at)
     values ($1, $2, $3) on conflict do nothing returning id`,
    [user.userId, user.privyDid, now],
  );
  if (rows.length === 1) return true;
  const existing = await tx.query<{ id: string; privy_did: string }>(
    "select id, privy_did from mandate_v2.users where id = $1 or privy_did = $2",
    [user.userId, user.privyDid],
  );
  const found = existing.rows[0];
  if (existing.rows.length === 1 && found?.id === user.userId && found.privy_did === user.privyDid)
    return false;
  throw new Problem(
    409,
    "user-conflict",
    "The target changed since the plan was built",
    `mandate_v2 already holds a user that collides with ${user.privyDid} (planned id ${user.userId}). Re-run plan against the current database before applying.`,
  );
}

/**
 * Insert one draft, or establish that the identical draft is already there.
 *
 * `on conflict do nothing` without naming a constraint, deliberately. Two unique keys can be
 * hit here — the primary key and `drafts_artifact_id_unique` — and naming only the first
 * would turn an artifact collision into a raw 23505 that aborts the transaction with a
 * message about a constraint rather than about what went wrong. Suppressing both and then
 * asking what is actually in the table lets every case be reported precisely.
 *
 * The follow-up select runs under the same tenant adoption, so a row that exists but belongs
 * to someone else is invisible to it and lands in the final branch. That is the right answer:
 * a draft id derived from this user's id which already exists under another tenant is
 * corruption, not idempotency, and no run should continue past it.
 */
async function insertDraft(tx: SqlClient, draft: PlannedDraft): Promise<"inserted" | "present"> {
  const row = draft.row;
  const placeholders = DRAFT_COLUMNS.map((_, index) => `$${index + 1}`).join(", ");
  const { rows } = await tx.query<{ id: string }>(
    `insert into mandate_v2.drafts (${DRAFT_COLUMNS.join(", ")})
     values (${placeholders}) on conflict do nothing returning id`,
    [
      row.id,
      row.userId,
      row.account,
      row.artifactId,
      row.name,
      row.mode,
      JSON.stringify(row.plan),
      JSON.stringify(row.envelope),
      row.reading,
      row.renderText,
      row.renderHash,
      row.confirmMessage,
      row.createdAt,
      row.expiresAt,
    ],
  );
  if (rows.length === 1) return "inserted";
  const existing = await tx.query<{ artifact_id: string }>(
    "select artifact_id from mandate_v2.drafts where id = $1",
    [row.id],
  );
  const found = existing.rows[0];
  if (found?.artifact_id === row.artifactId) return "present";
  if (found)
    throw new Problem(
      409,
      "draft-collision",
      "Draft id already used by different content",
      `Draft ${row.id} exists with artifact ${found.artifact_id} but this run derived ${row.artifactId} from strategy_version ${draft.legacy.versionId}. Two different strategies cannot share a draft id.`,
    );
  throw new Problem(
    409,
    "draft-collision",
    "Draft could not be written",
    `Draft ${row.id} for strategy_version ${draft.legacy.versionId} was refused by a unique constraint and is not visible to its own tenant. Its id or its artifact digest is already taken by another user's row.`,
  );
}

/** Group by tenant so the transaction adopts each user once rather than once per draft. */
function byTenant(drafts: readonly PlannedDraft[]): ReadonlyMap<string, PlannedDraft[]> {
  const out = new Map<string, PlannedDraft[]>();
  for (const draft of drafts) {
    // Drafts a previous run imported are not re-attempted. `on conflict do nothing` would
    // handle them harmlessly, but skipping keeps them out of THIS run's journal, and that
    // matters: rolling this run back must not delete rows an earlier run owns and is itself
    // still on the hook to remove.
    if (draft.alreadyPresent) continue;
    const list = out.get(draft.row.userId) ?? [];
    list.push(draft);
    out.set(draft.row.userId, list);
  }
  return out;
}

/**
 * The `TargetDirectory` the planner reads through, over a live `mandate_v2` session.
 *
 * Separate from the writes above so a rehearsal can be given exactly this and nothing else.
 */
export function targetDirectory(client: SqlClient): TargetDirectory {
  return {
    async usersByDid(dids) {
      if (dids.length === 0) return new Map();
      const { rows } = await client.query<{ id: string; privy_did: string }>(
        "select id, privy_did from mandate_v2.users where privy_did = any($1::text[])",
        [[...dids]],
      );
      return new Map(rows.map((row) => [row.privy_did, row.id]));
    },
    async didsById(ids) {
      if (ids.length === 0) return new Map();
      const { rows } = await client.query<{ id: string; privy_did: string }>(
        "select id, privy_did from mandate_v2.users where id = any($1::uuid[])",
        [[...ids]],
      );
      return new Map(rows.map((row) => [row.id, row.privy_did]));
    },
    async draftsFor(userId, ids) {
      if (ids.length === 0) return new Map();
      // Inside a tenant adoption, and inside its own transaction, because `set_config` with
      // `is_local = true` outside a transaction block affects only the statement it rides on.
      return withTransaction(client, () =>
        asTenant(client, userId, async () => {
          const { rows } = await client.query<{ id: string; artifact_id: string }>(
            "select id, artifact_id from mandate_v2.drafts where id = any($1::uuid[])",
            [[...ids]],
          );
          return new Map(rows.map((row) => [row.id, row.artifact_id]));
        }),
      );
    },
  };
}
