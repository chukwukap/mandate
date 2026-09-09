import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type Database, databaseReady } from "../src/client.js";
import * as schema from "../src/schema/index.js";

const db = new PGlite();
const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const draft = "00000000-0000-4000-8000-000000000003";
beforeAll(async () => {
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  }
  await db.query(
    "insert into mandate_v2.users (id, privy_did) values ($1, 'did:privy:alice'), ($2, 'did:privy:bob')",
    [alice, bob],
  );
  await db.exec(
    "create role api_test nologin; grant usage on schema mandate_v2 to api_test; grant select, insert, update, delete on all tables in schema mandate_v2 to api_test; set role api_test",
  );
  await db.query("select set_config('mandate.user_id', $1, false)", [alice]);
  await db.query(
    `insert into mandate_v2.drafts (id,user_id,account,artifact_id,name,mode,plan,envelope,reading,render_text,render_hash,confirm_message,created_at,expires_at)
    values ($1,$2,'0x1111111111111111111111111111111111111111','artifact','Demo','manual','{}','{}','Reading','Review','hash','Sign',now(),now()+interval '1 hour')`,
    [draft, alice],
  );
}, 30000);
afterAll(async () => {
  await db.close();
});
test("all tenant tables force RLS", async () => {
  const result = await db.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    "select relname,relrowsecurity,relforcerowsecurity from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='mandate_v2' and relkind='r' and relname not in ('users', 'worker_state') order by relname",
  );
  expect(result.rows.map((row) => row.relname)).toEqual([
    "drafts",
    "evaluations",
    "executions",
    "instances",
    "transactions",
  ]);
  expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
});

/**
 * Migration 0006 is the one that retires the spend-permission design. The table going is the
 * easy half; the harder half is that nothing which decides whether a database is usable may
 * still expect it there. `databaseReady` gates both the API's readiness probe and the worker's
 * startup, and a probe of a dropped table would report every migrated database as unmigrated.
 */
test("the permissions table is gone, and readiness does not miss it", async () => {
  const tables = await db.query<{ relname: string }>(
    "select relname from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='mandate_v2' and relname='permissions'",
  );
  expect(tables.rows).toHaveLength(0);
  // The session is `api_test` here — neither superuser nor RLS-bypassing — so the check gets
  // past its role guard and actually probes the tables.
  expect(await databaseReady(drizzle(db, { schema }) as unknown as Database)).toBe(true);
});

/**
 * Two things apply migrations: these tests, which list the directory, and `db:migrate`, which
 * asks drizzle's migrator — and the migrator only knows a file through `meta/_journal.json`.
 * A migration written by hand and never journaled passes every test in this package while a
 * real database never receives it. This is the assertion that closes that gap.
 */
test("every migration on disk is registered with the migrator", async () => {
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", dir), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files);
  // Indices are the migrator's ordering; a duplicate or a gap applies files out of sequence.
  expect(journal.entries.map((entry) => entry.idx)).toEqual(files.map((_, index) => index));
});
test("API readiness does not require access to signed transaction payloads", async () => {
  await db.exec(
    "reset role; revoke all on mandate_v2.transactions from api_test; set role api_test",
  );
  try {
    await expect(db.query("select id from mandate_v2.transactions limit 0")).rejects.toMatchObject({
      code: "42501",
    });
    expect(await databaseReady(drizzle(db, { schema }) as unknown as Database)).toBe(true);
  } finally {
    await db.exec(
      "reset role; grant select, insert, update, delete on mandate_v2.transactions to api_test; set role api_test",
    );
  }
});
test("a different user cannot read or consume another user's draft", async () => {
  await db.query("select set_config('mandate.user_id', $1, false)", [bob]);
  expect((await db.query("select id from mandate_v2.drafts")).rows).toHaveLength(0);
  expect(
    (
      await db.query("update mandate_v2.drafts set consumed_at=now() where id=$1 returning id", [
        draft,
      ])
    ).rows,
  ).toHaveLength(0);
});
test("no tenant context reveals no rows", async () => {
  await db.query("select set_config('mandate.user_id', '', false)");
  expect((await db.query("select id from mandate_v2.drafts")).rows).toHaveLength(0);
});
test("signed content cannot be changed, consumed drafts cannot be reopened", async () => {
  await db.query("select set_config('mandate.user_id', $1, false)", [alice]);
  await expect(
    db.query("update mandate_v2.drafts set render_text='changed' where id=$1", [draft]),
  ).rejects.toMatchObject({ code: "23514" });
  await db.query("update mandate_v2.drafts set consumed_at=now() where id=$1", [draft]);
  await expect(
    db.query("update mandate_v2.drafts set consumed_at=null where id=$1", [draft]),
  ).rejects.toMatchObject({ code: "23514" });
});
test("Privy identity is unique and cannot be a wallet-address substitute", async () => {
  await expect(
    db.query(
      "insert into mandate_v2.users (id,privy_did) values (gen_random_uuid(),'did:privy:alice')",
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    db.query("insert into mandate_v2.users (id,privy_did) values (gen_random_uuid(),'0x1111')"),
  ).rejects.toMatchObject({ code: "23514" });
});
