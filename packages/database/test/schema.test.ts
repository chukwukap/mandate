import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

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
    "select relname,relrowsecurity,relforcerowsecurity from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='mandate_v2' and relkind='r' and relname not in ('users', 'worker_state')",
  );
  expect(result.rows).toHaveLength(6);
  expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
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
