import { randomBytes } from "node:crypto";
import {
  connectDatabase,
  type Database,
  Repository,
} from "../../../packages/database/src/index.js";

/**
 * The one real PostgreSQL every integration suite runs against.
 *
 * These tests exist because PGlite is not PostgreSQL. It has no second session, so it cannot
 * show one worker waiting on another's `FOR UPDATE`; it does not produce 40001 under contention,
 * so the retry loop in `withTransaction` is never actually exercised; and it runs everything as
 * the bootstrap superuser, so `FORCE ROW LEVEL SECURITY` is decoration rather than enforcement.
 * Every property in these directories is one of those three, or the real Fastify pipeline on top
 * of them. Anything provable against a fake belongs in the package's own `test/` folder, not here.
 *
 * Nothing here opens a socket to anything but the configured database. There is no chain access,
 * no Privy, no Anthropic: the chain is the recorded fixture client in `tests/fixtures/chain`.
 *
 * `tests/` has no `node_modules` of its own, so `pg`, `drizzle-orm` and `viem` cannot be imported
 * by bare specifier from here (verified: bun answers "Cannot find package"). That shapes the whole
 * harness — assertions are raw SQL through the pool that `connectDatabase` already exposes, which
 * is the right instinct anyway: checking drizzle's writes with drizzle's own query builder means a
 * mapping bug agrees with itself.
 */

export type Row = Record<string, unknown>;

/** Parameterised SQL, scoped to whatever transaction the caller is inside. */
export type Query = <T extends Row = Row>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type Postgres = {
  readonly db: Database;
  readonly repo: Repository;
  /** node-postgres pool. Raw SQL goes through this, never through drizzle. */
  readonly pool: ReturnType<typeof connectDatabase>["pool"];
  close(): Promise<void>;
};

/** Everything `mandate_v2` must contain before a suite can mean anything. */
const REQUIRED_TABLES = [
  "users",
  "drafts",
  "instances",
  "permissions",
  "evaluations",
  "executions",
  "transactions",
  "worker_state",
] as const;

/**
 * `TEST_DATABASE_URL` wins over `DATABASE_URL`.
 *
 * The suites write and delete rows, so an explicitly nominated test database has to be able to
 * override the one the developer's API is pointed at. Falling back to `DATABASE_URL` is what the
 * brief asks for and what CI provides; on a laptop it is usually the local development database,
 * which is why every tenant these suites create is namespaced and torn down (see `discardTenant`).
 */
export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/**
 * The worker's own credentials, for suites that assert worker-owned behaviour.
 *
 * The transaction journal and the execution ledger are written by the worker and by nobody else:
 * infra/postgres/03-grants.sql gives the API SELECT on `executions` and nothing at all on
 * `transactions`, because the API has no signer and never broadcasts. A suite that exercises
 * `writeExecutionLeg` is therefore exercising the WORKER's path, and connecting it as the API
 * role tests a combination that does not exist — it answers "permission denied" for a statement
 * the real writer is allowed to make.
 *
 * Derived from DATABASE_URL by swapping the role when not given explicitly, so a developer who
 * has one database configured gets both roles without a second variable.
 */
export const WORKER_DATABASE_URL =
  process.env.TEST_WORKER_DATABASE_URL ??
  (DATABASE_URL
    ? DATABASE_URL.replace(/\/\/[^:]+:[^@]+@/, "//mandate_worker:mandate_worker@")
    : undefined);

/** Host and database only. A connection string carries a password and must never be logged. */
function target(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "the configured database";
  }
}

export type Probe = {
  /** Undefined when the suites can run. Otherwise one sentence explaining the skip. */
  readonly unavailable: string | undefined;
  /**
   * True when the connecting role is subject to row level security.
   *
   * A superuser or a `BYPASSRLS` role satisfies every policy silently, so the tenant-isolation
   * assertions would pass for the wrong reason. They are skipped rather than failed: a CI image
   * that hands out an owner role is a configuration choice, not a broken build, and the other
   * ~40 properties in these suites are still worth running.
   */
  readonly rlsEnforced: boolean;
};

/**
 * Reachability, migration state and role privileges, decided once per process.
 *
 * Top-level await rather than a `beforeAll`, because `describe.skipIf` needs its answer at
 * collection time — a suite that discovers the database is missing inside `beforeAll` reports a
 * failed hook, which is exactly the noisy failure the brief asks to avoid. The probe closes its
 * own connection; each suite opens its own pool through `openPostgres` and owns its lifetime.
 */
async function probe(): Promise<Probe> {
  const unusable = (reason: string): Probe => ({ unavailable: reason, rlsEnforced: false });
  if (!DATABASE_URL)
    return unusable(
      "DATABASE_URL (or TEST_DATABASE_URL) is not set, so there is no PostgreSQL to integrate against.",
    );
  let protocol: string;
  try {
    protocol = new URL(DATABASE_URL).protocol;
  } catch {
    return unusable("DATABASE_URL is not a URL.");
  }
  if (!["postgres:", "postgresql:"].includes(protocol))
    return unusable("DATABASE_URL does not point at PostgreSQL.");

  const connection = connectDatabase(DATABASE_URL);
  try {
    // `pg_tables`, not `information_schema.tables`. The latter lists only tables the CURRENT
    // ROLE holds a privilege on, so under the correctly-restricted application role —
    // which is granted nothing at all on `transactions`, deliberately, because the API has no
    // signer — this probe concluded the database was unmigrated and skipped every integration
    // suite. The security property was working; the probe was asking the wrong catalogue.
    const tables = await connection.pool
      .query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'mandate_v2'",
      )
      .then((result) => new Set(result.rows.map((row) => row.tablename)));
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length > 0)
      return unusable(
        `${target(DATABASE_URL)} is reachable but not migrated (missing ${missing.join(", ")}). Run: bun run db:migrate`,
      );
    // The migration role owns the schema and the application role does not; only the second one
    // can prove a policy. Deliberately not a skip on its own — see `Probe.rlsEnforced`.
    const role = await connection.pool.query<{ superuser: boolean; bypass: boolean }>(
      "select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = current_user",
    );
    const privileged = role.rows[0]?.superuser !== false || role.rows[0]?.bypass !== false;
    return { unavailable: undefined, rlsEnforced: !privileged };
  } catch {
    // The driver error carries the connection string. Classify it, never surface it.
    return unusable(
      `PostgreSQL at ${target(DATABASE_URL)} could not be reached, so the integration suites cannot run.`,
    );
  } finally {
    await connection.close().catch(() => {});
  }
}

export const POSTGRES: Probe = await probe();

if (POSTGRES.unavailable) console.warn(`[integration] skipped: ${POSTGRES.unavailable}`);

/**
 * Opens a pool for one suite. The caller closes it; suites must not share one.
 *
 * `as: "worker"` connects with the worker's grants. Use it for anything that writes the journal
 * or the execution ledger; the default application role is refused those tables on purpose.
 */
export function openPostgres(options: { as?: "app" | "worker" } = {}): Postgres {
  const url = options.as === "worker" ? WORKER_DATABASE_URL : DATABASE_URL;
  if (!url) throw new Error("openPostgres called without a database; check POSTGRES");
  const connection = connectDatabase(url);
  return {
    db: connection.db,
    repo: new Repository(connection.db),
    pool: connection.pool,
    close: () => connection.close(),
  };
}

/**
 * A fresh application user, unique to this run.
 *
 * Every suite works inside tenants it created, never against rows that were already there. That
 * is what makes it safe to point `DATABASE_URL` at a development database: two concurrent runs
 * cannot collide, and a run that dies half way leaves rows that belong to nobody real.
 */
export async function newTenant(pg: Postgres): Promise<string> {
  const user = await pg.repo.resolvePrivyUser(`did:privy:it${randomBytes(12).toString("hex")}`);
  return user.id;
}

/**
 * Run raw SQL inside one transaction with the tenant setting applied.
 *
 * `set_config(..., true)` is transaction-local, which is the whole of the RLS identity: a
 * statement issued outside this block sees nothing at all under the application role. Assertions
 * therefore have to opt in to a tenant explicitly, which is a feature — a query that forgets
 * comes back empty rather than quietly reading somebody else's rows.
 */
export async function asTenant<T>(
  pg: Postgres,
  userId: string,
  run: (query: Query) => Promise<T>,
): Promise<T> {
  const client = await pg.pool.connect();
  const query: Query = async <T extends Row = Row>(text: string, values?: readonly unknown[]) => {
    const result = await client.query(text, values ? [...values] : undefined);
    return result.rows as T[];
  };
  try {
    await client.query("begin");
    await client.query("select set_config('mandate.user_id', $1, true)", [userId]);
    const value = await run(query);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Raw SQL with no tenant context. For `worker_state` and for proving RLS hides a row. */
export async function withoutTenant<T>(
  pg: Postgres,
  run: (query: Query) => Promise<T>,
): Promise<T> {
  const client = await pg.pool.connect();
  const query: Query = async <T extends Row = Row>(text: string, values?: readonly unknown[]) => {
    const result = await client.query(text, values ? [...values] : undefined);
    return result.rows as T[];
  };
  try {
    return await run(query);
  } finally {
    client.release();
  }
}

/**
 * Remove everything this run created for one tenant, as far as the schema permits.
 *
 * It does not permit everything, and that is deliberate rather than an oversight. Migration 0005
 * installs a BEFORE DELETE trigger on `mandate_v2.transactions` that raises 23514 unconditionally:
 * the journal is append-only, so a signed transaction cannot be erased by anyone — including the
 * test that wrote it. Rows that were journalled therefore survive, along with the `executions`,
 * `instances`, `drafts` and `users` rows they depend on. A harness that could tidy those away
 * would be proof the append-only guarantee is not real. `test/journal.test.ts` asserts the refusal
 * directly rather than leaving it as a comment.
 *
 * Each statement runs in its own transaction so one refusal does not abort the rest, and every
 * failure is swallowed: teardown must never turn a passing suite red.
 */
export async function discardTenant(pg: Postgres, userId: string): Promise<void> {
  const scoped = [
    "delete from mandate_v2.evaluations where user_id = $1",
    // Only orders with nothing in the journal. The rest are load-bearing history now.
    "delete from mandate_v2.executions e where e.user_id = $1 and not exists (select 1 from mandate_v2.transactions t where t.execution_id = e.id)",
    "delete from mandate_v2.permissions where user_id = $1",
    "delete from mandate_v2.instances i where i.user_id = $1 and not exists (select 1 from mandate_v2.executions e where e.instance_id = i.id)",
    "delete from mandate_v2.drafts d where d.user_id = $1 and not exists (select 1 from mandate_v2.instances i where i.draft_id = d.id)",
  ];
  for (const statement of scoped)
    await asTenant(pg, userId, (query) => query(statement, [userId])).catch(() => {});
  // `users` carries no policy — it is the table the policies resolve against — so it is deleted
  // without a tenant context, and only once nothing references it.
  await withoutTenant(pg, (query) =>
    query("delete from mandate_v2.users where id = $1", [userId]),
  ).catch(() => {});
}

/** Discards several tenants, oldest first. Safe to call with ids that were never created. */
export async function discardTenants(pg: Postgres, userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) await discardTenant(pg, userId);
}

/** `count` as a number. `count(*)` comes back from the driver as a string, and `"0"` is truthy. */
export async function countOf(query: Query, text: string, values?: readonly unknown[]) {
  const rows = await query<{ count: string }>(text, values);
  return Number(rows[0]?.count ?? "0");
}

/** SQLSTATE of whatever the driver threw, without ever exposing the error itself. */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Deterministic pause. Used only to order two sessions against each other, never to poll. */
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
