import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export function connectDatabase(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
export async function tenant<T>(
  db: Database,
  userId: string,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('mandate.user_id', ${userId}, true)`);
    return run(tx);
  });
}
export async function databaseReady(db: Database) {
  try {
    // Checking named columns catches a reachable but unmigrated database.
    const role = await db.execute<{ bypass: boolean }>(
      sql`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`,
    );
    if (role.rows[0]?.bypass !== false) return false;
    await db.execute(sql`select id, privy_did from mandate_v2.users limit 0`);
    await db.execute(sql`select id, artifact_id, account from mandate_v2.drafts limit 0`);
    await db.execute(sql`select id, runtime from mandate_v2.instances limit 0`);
    await db.execute(sql`select id, inputs from mandate_v2.evaluations limit 0`);
    await db.execute(sql`select id, tx_hash from mandate_v2.executions limit 0`);
    // The API cannot read signed transaction payloads. Inspect the journal's structure through
    // the catalogue so readiness works with both API and worker permissions.
    const journal = await db.execute<{ present: boolean }>(sql`
      select count(*) = 3 as present from pg_attribute
      where attrelid = to_regclass('mandate_v2.transactions')
        and attname in ('id', 'leg', 'hash') and not attisdropped
    `);
    if (journal.rows[0]?.present !== true) return false;
    return true;
  } catch {
    return false;
  }
}
