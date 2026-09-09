import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/client.js";
import { tenant } from "../src/client.js";
import { Repository } from "../src/repositories/index.js";
import * as schema from "../src/schema/index.js";
import { WorkerStore } from "../src/worker.js";

/**
 * The instance writes that replaced permission grants.
 *
 * Under the retired design, turning automatic buying on meant writing a permission row and an
 * instance row together. Now the authority lives with Privy — the user delegates their embedded
 * wallet to the app's signer — and the database holds only the instance's `mode`. That makes
 * `setMode` the whole of the API's write when delegation is confirmed or withdrawn, and the
 * worker's `context` the whole of what it needs to find the wallet that signs.
 */

const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const liveDraft = "00000000-0000-4000-8000-000000000010";
const liveInstance = "00000000-0000-4000-8000-000000000011";
const endedDraft = "00000000-0000-4000-8000-000000000012";
const endedInstance = "00000000-0000-4000-8000-000000000013";

const client = new PGlite();
let db: Database;
let repository: Repository;
let store: WorkerStore;

async function draftRow(id: string, artifactId: string) {
  const now = new Date();
  return {
    id,
    userId: alice,
    account: "0x1111111111111111111111111111111111111111",
    artifactId,
    name: "Demo",
    mode: "manual",
    plan: {} as never,
    envelope: { caps: { expires_at: "2030-01-01T00:00:00.000Z" } } as never,
    reading: "Reading",
    renderText: "Review",
    renderHash: "hash",
    confirmMessage: "Sign",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
    consumedAt: now,
  };
}

beforeAll(async () => {
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort())
    await client.exec(await readFile(new URL(file, dir), "utf8"));
  await client.query(
    "insert into mandate_v2.users (id, privy_did) values ($1,'did:privy:alice'), ($2,'did:privy:bob')",
    [alice, bob],
  );
  await client.exec(
    "create role api_test nologin; grant usage on schema mandate_v2 to api_test; grant select, insert, update, delete on all tables in schema mandate_v2 to api_test; set role api_test",
  );
  db = drizzle(client, { schema }) as unknown as Database;
  repository = new Repository(db);
  // `context` never touches the lease; the assertion is what `write` would call.
  store = new WorkerStore(db, { assert: async () => {} });
  const now = new Date();
  await tenant(db, alice, async (tx) => {
    await tx
      .insert(schema.drafts)
      .values([
        await draftRow(liveDraft, "artifact-live"),
        await draftRow(endedDraft, "artifact-ended"),
      ]);
    await tx.insert(schema.instances).values([
      {
        id: liveInstance,
        userId: alice,
        draftId: liveDraft,
        name: "Live",
        mode: "auto",
        status: "armed",
        signature: "0xsig",
        runtime: {} as never,
        createdAt: now,
        updatedAt: now,
        nextTickAt: now,
      },
      {
        id: endedInstance,
        userId: alice,
        draftId: endedDraft,
        name: "Ended",
        mode: "auto",
        status: "halted",
        haltReason: "Stopped by user",
        signature: "0xsig",
        runtime: {} as never,
        createdAt: now,
        updatedAt: now,
        nextTickAt: now,
      },
    ]);
  });
}, 60_000);

afterAll(async () => {
  await client.close();
});

/** Read outside any unit of work, as Alice, so the assertion sees exactly what committed. */
async function instanceRow(id: string) {
  await client.query("select set_config('mandate.user_id', $1, false)", [alice]);
  const rows = await client.query<{ mode: string; status: string; updated_at: Date }>(
    "select mode, status, updated_at from mandate_v2.instances where id=$1",
    [id],
  );
  return rows.rows[0];
}

describe("Repository.setMode", () => {
  test("going manual pauses an armed strategy in the same write", async () => {
    // A user who withdraws the delegation must not be left with an armed rule that fires and
    // then cannot sign. Pausing here, rather than leaving it to the worker to discover, means
    // the next tick never claims the instance at all.
    const now = new Date(Date.now() - 5_000);
    const updated = await repository.setMode(alice, liveInstance, "manual", now);
    expect(updated.mode).toBe("manual");
    expect(updated.status).toBe("paused");
    expect(updated.updatedAt.getTime()).toBe(now.getTime());
    expect(await instanceRow(liveInstance)).toMatchObject({ mode: "manual", status: "paused" });
  });

  test("going auto does not arm; arming is the user's separate decision", async () => {
    const updated = await repository.setMode(alice, liveInstance, "auto");
    expect(updated.mode).toBe("auto");
    expect(updated.status).toBe("paused");
    expect(await instanceRow(liveInstance)).toMatchObject({ mode: "auto", status: "paused" });
  });

  test("going manual on a strategy that is not armed only changes the mode", async () => {
    const before = await instanceRow(liveInstance);
    const updated = await repository.setMode(alice, liveInstance, "manual");
    expect(updated.status).toBe("paused");
    // `updatedAt` still moves: the write happened, and the worker's lock compares it.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? 0);
  });

  test("a halted or ended strategy refuses either mode", async () => {
    for (const mode of ["auto", "manual"] as const)
      await expect(repository.setMode(alice, endedInstance, mode)).rejects.toMatchObject({
        status: 409,
        code: "terminal-instance",
      });
    // Refused means untouched: a terminal instance needs a new signed draft, not a mode.
    expect(await instanceRow(endedInstance)).toMatchObject({ mode: "auto", status: "halted" });
  });

  test("another user's strategy is not found, not forbidden", async () => {
    await expect(repository.setMode(bob, liveInstance, "auto")).rejects.toMatchObject({
      status: 404,
    });
    expect(await instanceRow(liveInstance)).toMatchObject({ mode: "manual" });
  });
});

describe("WorkerStore.context", () => {
  test("carries the owner's Privy identity and nothing about permissions", async () => {
    const context = await store.context(alice, liveInstance);
    expect(context.instance.id).toBe(liveInstance);
    expect(context.draft.id).toBe(liveDraft);
    // The DID is how the worker asks Privy for the wallet that signs this strategy's orders;
    // the id is the tenant every write is scoped to. Nothing else about the user travels.
    expect(context.owner).toEqual({ id: alice, privyDid: "did:privy:alice" });
    expect(Object.keys(context).sort()).toEqual(["draft", "instance", "owner"]);
  });

  test("an instance the tenant cannot see is unavailable, not another user's", async () => {
    await expect(store.context(bob, liveInstance)).rejects.toThrow("Instance unavailable");
  });
});
