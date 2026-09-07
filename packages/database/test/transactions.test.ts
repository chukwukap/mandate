import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Problem } from "@mandate/contracts";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database, Transaction } from "../src/client.js";
import * as schema from "../src/schema/index.js";
import {
  isRetryable,
  isUniqueViolation,
  NonceReused,
  recordExecutionLeg,
  recordPermissionGrant,
  sqlState,
  UNIT_OPTIONS,
  WriteConflict,
  withTenant,
  withTransaction,
  writeExecutionLeg,
  writePermissionGrant,
} from "../src/transactions/index.js";

/**
 * A driver error shaped the way drizzle actually delivers one: the pg error is the `cause` of a
 * `DrizzleQueryError` whose own message embeds the SQL and its bound parameters. Every
 * classification test goes through this wrapper, because reading `error.code` off the top-level
 * throw is the mistake that would make the retry loop silently never retry.
 */
function driverError(code: string, extra: Record<string, unknown> = {}) {
  const inner = Object.assign(new Error("relation error"), { code, ...extra });
  return Object.assign(new Error("Failed query: update ...\nparams: 0xdeadbeef"), {
    cause: inner,
  });
}

type FakeCall = { isolationLevel?: string; accessMode?: string } | undefined;

/**
 * A `Database` stand-in. It has no `rollback`, which is precisely how `isTransaction`
 * distinguishes the pool from an open transaction, and it hands the body a `tx` that does.
 */
function fakeDatabase(bodies: Array<() => Promise<unknown>>, isolation = "read committed") {
  const configs: FakeCall[] = [];
  const executed: string[] = [];
  let attempt = 0;
  const tx = {
    rollback() {
      throw new Error("rollback");
    },
    execute: async (query: unknown) => {
      executed.push(JSON.stringify(query));
      return { rows: [{ level: isolation, current: null }] };
    },
  };
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>, config: FakeCall) => {
      configs.push(config);
      const body = bodies[Math.min(attempt, bodies.length - 1)];
      attempt += 1;
      await fn(tx);
      if (!body) throw new Error("no body");
      return body();
    },
  };
  return { db: db as unknown as Database, configs, executed, attempts: () => attempt };
}

const NEVER_SLEEP = () => 0;

describe("SQLSTATE classification", () => {
  test("reads the code through drizzle's wrapper, not off the top-level error", () => {
    expect(sqlState(driverError("40001"))).toBe("40001");
    expect(isRetryable(driverError("40001"))).toBe(true);
    expect(isRetryable(driverError("40P01"))).toBe(true);
  });
  test("a dead socket is never retried: the commit may already have landed", () => {
    expect(isRetryable(driverError("08006"))).toBe(false);
    expect(isRetryable(Object.assign(new Error("socket"), { code: "ECONNRESET" }))).toBe(false);
    // ECONNRESET is not five uppercase characters, so it is not mistaken for a SQLSTATE.
    expect(sqlState(Object.assign(new Error("socket"), { code: "ECONNRESET" }))).toBeUndefined();
  });
  test("deterministic failures and deliberate refusals are not retried", () => {
    expect(isRetryable(driverError("23505"))).toBe(false);
    expect(isRetryable(driverError("23514"))).toBe(false);
    expect(isRetryable(driverError("57014"))).toBe(false);
    expect(isRetryable(new Problem(409, "expired", "Expired", "detail"))).toBe(false);
  });
  test("unique violations can be narrowed to one constraint", () => {
    const error = driverError("23505", { constraint: "signer_nonce" });
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, "signer_nonce")).toBe(true);
    expect(isUniqueViolation(error, "execution_leg")).toBe(false);
  });
  test("a self-referential cause chain terminates instead of hanging", () => {
    const loop: { cause?: unknown; code?: string } = {};
    loop.cause = loop;
    expect(sqlState(loop)).toBeUndefined();
  });
});

describe("withTransaction retry budget", () => {
  test("a serialization failure is retried and the second attempt's result is returned", async () => {
    const fail = () => Promise.reject(driverError("40001"));
    const { db, attempts } = fakeDatabase([fail, async () => "committed"]);
    const seen: number[] = [];
    const result = await withTransaction(db, { backoffMs: NEVER_SLEEP }, async (_tx, attempt) => {
      seen.push(attempt.number);
      return attempt.previousFailure ?? "first";
    });
    // The body ran twice; the value returned is the second attempt's.
    expect(seen).toEqual([1, 2]);
    expect(attempts()).toBe(2);
    expect(result).toBe("committed");
  });
  test("the second attempt is told why the first was abandoned", async () => {
    const { db } = fakeDatabase([() => Promise.reject(driverError("40P01")), async () => "ok"]);
    const failures: Array<string | undefined> = [];
    await withTransaction(db, { backoffMs: NEVER_SLEEP }, async (_tx, attempt) => {
      failures.push(attempt.previousFailure);
    });
    expect(failures).toEqual([undefined, "40P01"]);
  });
  test("exhausting the budget raises a 503 that carries the code, never the driver error", async () => {
    const { db, attempts } = fakeDatabase([() => Promise.reject(driverError("40001"))]);
    const retries: number[] = [];
    const error = await withTransaction(
      db,
      { backoffMs: NEVER_SLEEP, onRetry: (info) => retries.push(info.attempt) },
      async () => "never",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(WriteConflict);
    expect(error).toBeInstanceOf(Problem);
    expect(error.status).toBe(503);
    expect(error.code).toBe("write-conflict");
    expect(error.attempts).toBe(3);
    expect(error.sqlState).toBe("40001");
    expect(attempts()).toBe(3);
    expect(retries).toEqual([2, 3]);
    // The bound parameters that drizzle interpolates into its wrapper must not travel with it.
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("0xdeadbeef");
    expect(error.cause).toBeUndefined();
  });
  test("maxAttempts of 1 disables retry entirely", async () => {
    const { db, attempts } = fakeDatabase([() => Promise.reject(driverError("40001"))]);
    await expect(
      withTransaction(db, { maxAttempts: 1, backoffMs: NEVER_SLEEP }, async () => "x"),
    ).rejects.toBeInstanceOf(WriteConflict);
    expect(attempts()).toBe(1);
  });
  test("a non-retryable failure is rethrown untouched on the first attempt", async () => {
    const refusal = new Problem(409, "draft-consumed", "Gone", "detail");
    const { db, attempts } = fakeDatabase([() => Promise.reject(refusal)]);
    await expect(withTransaction(db, {}, async () => "x")).rejects.toBe(refusal);
    expect(attempts()).toBe(1);
  });
  test("the deadline is checked before sleeping, not after", async () => {
    const { db, attempts } = fakeDatabase([() => Promise.reject(driverError("40001"))]);
    const started = Date.now();
    await expect(
      withTransaction(
        db,
        { deadlineMs: 40, backoffMs: () => 1000, maxAttempts: 10 },
        async () => "x",
      ),
    ).rejects.toBeInstanceOf(WriteConflict);
    // A 1000ms backoff that would not fit inside a 40ms deadline is never waited out.
    expect(Date.now() - started).toBeLessThan(200);
    expect(attempts()).toBe(1);
  });
  test("the requested isolation level reaches the driver", async () => {
    const { db, configs } = fakeDatabase([async () => "ok"]);
    await withTransaction(
      db,
      { isolationLevel: "serializable", accessMode: "read only" },
      async () => undefined,
    );
    expect(configs[0]).toEqual({ isolationLevel: "serializable", accessMode: "read only" });
  });
  // An empty config object is not the same as no config: drizzle tests it for truthiness and
  // emits a modifier clause with nothing in it, which the pglite driver rejects as a syntax error.
  test("no options means no BEGIN modifiers at all", async () => {
    const { db, configs } = fakeDatabase([async () => "ok"]);
    await withTransaction(db, {}, async () => undefined);
    expect(configs[0]).toBeUndefined();
  });
});

describe("withTransaction composition", () => {
  const openTransaction = (isolation: string) =>
    ({
      rollback() {},
      execute: async () => ({ rows: [{ level: isolation }] }),
    }) as unknown as Transaction;

  test("nested work runs inline in the caller's transaction, with no savepoint and no retry", async () => {
    let ran = 0;
    const tx = openTransaction("read committed");
    const result = await withTransaction(tx, {}, async (inner, attempt) => {
      ran += 1;
      expect(inner).toBe(tx);
      expect(attempt.number).toBe(1);
      return "inline";
    });
    expect(result).toBe("inline");
    expect(ran).toBe(1);
  });
  test("a nested failure propagates instead of being retried into a poisoned transaction", async () => {
    let ran = 0;
    await expect(
      withTransaction(openTransaction("serializable"), { backoffMs: NEVER_SLEEP }, async () => {
        ran += 1;
        throw driverError("40001");
      }),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(ran).toBe(1);
  });
  test("a unit written for serializable refuses to run under read committed", async () => {
    await expect(
      withTransaction(openTransaction("read committed"), { isolationLevel: "serializable" }, () =>
        Promise.resolve("x"),
      ),
    ).rejects.toThrow("requires serializable isolation");
  });
  test("a stronger ambient level satisfies a weaker requirement", async () => {
    await expect(
      withTransaction(openTransaction("serializable"), { isolationLevel: "repeatable read" }, () =>
        Promise.resolve("ok"),
      ),
    ).resolves.toBe("ok");
  });
});

describe("withTenant", () => {
  test("the tenant is re-established inside every attempt, not once outside the loop", async () => {
    const { db, executed } = fakeDatabase([
      () => Promise.reject(driverError("40001")),
      async () => "ok",
    ]);
    await withTenant(
      db,
      "00000000-0000-4000-8000-000000000001",
      { backoffMs: NEVER_SLEEP },
      async () => "ok",
    );
    const setConfigCalls = executed.filter((query) => query.includes("set_config"));
    expect(setConfigCalls).toHaveLength(2);
    expect(setConfigCalls[0]).toContain("00000000-0000-4000-8000-000000000001");
  });
  test("a malformed user id is refused before it reaches a ::uuid cast", async () => {
    const { db, attempts } = fakeDatabase([async () => "ok"]);
    await expect(withTenant(db, "alice", {}, async () => "ok")).rejects.toThrow(
      "application user id",
    );
    expect(attempts()).toBe(0);
  });
  test("a nested unit may not re-point an open transaction at another user", async () => {
    const tx = {
      rollback() {},
      execute: async () => ({ rows: [{ current: "00000000-0000-4000-8000-000000000001" }] }),
    } as unknown as Transaction;
    await expect(
      withTenant(tx, "00000000-0000-4000-8000-000000000002", {}, async () => "ok"),
    ).rejects.toThrow("Refusing to change the tenant");
    await expect(
      withTenant(tx, "00000000-0000-4000-8000-000000000001", {}, async () => "ok"),
    ).resolves.toBe("ok");
  });
});

// --- Real PostgreSQL behaviour -------------------------------------------------------------

const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const draftId = "00000000-0000-4000-8000-000000000010";
const instanceId = "00000000-0000-4000-8000-000000000011";
const permissionId = "00000000-0000-4000-8000-000000000012";
const executionId = "00000000-0000-4000-8000-000000000013";

const client = new PGlite();
let db: Database;

async function payload() {
  return {
    account: "0x1111111111111111111111111111111111111111",
    spender: "0x2222222222222222222222222222222222222222",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    allowance: "100000000",
    period: 86400,
    start: 0,
    end: 4102444800,
    salt: "1",
    extraData: "0x",
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
  const now = new Date();
  await withTenant(db, alice, {}, async (tx) => {
    await tx.insert(schema.drafts).values({
      id: draftId,
      userId: alice,
      account: "0x1111111111111111111111111111111111111111",
      artifactId: "artifact-1",
      name: "Demo",
      mode: "auto",
      plan: {} as never,
      envelope: {} as never,
      reading: "Reading",
      renderText: "Review",
      renderHash: "hash",
      confirmMessage: "Sign",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      consumedAt: now,
    });
    await tx.insert(schema.instances).values({
      id: instanceId,
      userId: alice,
      draftId,
      name: "Demo",
      signature: "0xsig",
      runtime: {} as never,
      createdAt: now,
      updatedAt: now,
      nextTickAt: now,
    });
    await tx.insert(schema.permissions).values({
      id: permissionId,
      userId: alice,
      instanceId,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payload: (await payload()) as never,
      hash: "0xhash-1",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(schema.executions).values({
      id: executionId,
      userId: alice,
      instanceId,
      status: "admitted",
      tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenOut: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      amountIn: "1000000",
      createdAt: now,
      updatedAt: now,
    });
  });
}, 60_000);

afterAll(async () => {
  await client.close();
});

/**
 * Verification reads go through the raw client, outside any unit of work, so they see exactly
 * what committed. They have to claim the tenant at session scope first: `withTenant` sets it
 * with `set_config(..., true)`, which is discarded with the transaction, and a read with no
 * tenant context returns zero rows under RLS rather than an error.
 */
async function asAlice() {
  await client.query("select set_config('mandate.user_id', $1, false)", [alice]);
}
async function permissionRow() {
  await asAlice();
  const rows = await client.query<{ status: string; signature: string | null }>(
    "select status, signature from mandate_v2.permissions where id=$1",
    [permissionId],
  );
  return rows.rows[0];
}
async function instanceRow() {
  await asAlice();
  const rows = await client.query<{ mode: string; status: string }>(
    "select mode, status from mandate_v2.instances where id=$1",
    [instanceId],
  );
  return rows.rows[0];
}
async function journal() {
  await asAlice();
  const rows = await client.query<{ leg: string; hash: string; nonce: number }>(
    "select leg, hash, nonce from mandate_v2.transactions where execution_id=$1 order by nonce",
    [executionId],
  );
  return rows.rows;
}
async function executionStage() {
  await asAlice();
  const rows = await client.query<{ stage: string }>(
    "select stage from mandate_v2.executions where id=$1",
    [executionId],
  );
  return rows.rows[0]?.stage;
}

describe("units of work against PostgreSQL", () => {
  test("the isolation level a unit asks for is the one the server actually uses", async () => {
    const level = await withTenant(db, alice, UNIT_OPTIONS, async (tx) => {
      const result = await tx.execute<{ level: string }>(
        sql`select current_setting('transaction_isolation') as level`,
      );
      return result.rows[0]?.level;
    });
    expect(level).toBe("repeatable read");
  });

  test("row-level security still applies inside a unit of work", async () => {
    const rows = await withTenant(db, bob, {}, (tx) => tx.select().from(schema.instances));
    expect(rows).toHaveLength(0);
  });

  test("a permission grant and its instance land in one commit", async () => {
    const now = new Date();
    const { permission, instance } = await recordPermissionGrant(db, {
      userId: alice,
      instanceId,
      permissionId,
      expectedHash: "0xhash-1",
      status: "active",
      signature: "0xdeadbeef",
      instance: { mode: "auto", status: "armed" },
      now,
    });
    expect(permission.status).toBe("active");
    expect(instance.mode).toBe("auto");
    expect(await permissionRow()).toEqual({ status: "active", signature: "0xdeadbeef" });
    expect(await instanceRow()).toEqual({ mode: "auto", status: "armed" });
  });

  test("a stale permission hash writes neither row", async () => {
    await expect(
      recordPermissionGrant(db, {
        userId: alice,
        instanceId,
        permissionId,
        expectedHash: "0xhash-superseded",
        status: "revoked",
        instance: { mode: "manual", status: "paused" },
        now: new Date(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "permission-state" });
    expect(await permissionRow()).toEqual({ status: "active", signature: "0xdeadbeef" });
    expect(await instanceRow()).toEqual({ mode: "auto", status: "armed" });
  });

  test("another user cannot reach the same permission at all", async () => {
    await expect(
      recordPermissionGrant(db, {
        userId: bob,
        instanceId,
        permissionId,
        expectedHash: "0xhash-1",
        status: "revoked",
        now: new Date(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await permissionRow()).toEqual({ status: "active", signature: "0xdeadbeef" });
  });

  test("a journalled leg and its execution update land in one commit", async () => {
    const result = await recordExecutionLeg(db, {
      userId: alice,
      executionId,
      id: "00000000-0000-4000-8000-000000000020",
      leg: "fund",
      signer: "0x3333333333333333333333333333333333333333",
      nonce: 7,
      rawTransaction: "0x02f8",
      hash: "0xfund",
      execution: { status: "pending", stage: "fund", txHash: "0xfund" },
      now: new Date(),
    });
    expect(result.replayed).toBe(false);
    expect(result.execution.status).toBe("pending");
    expect(result.execution.txHash).toBe("0xfund");
    expect(await journal()).toEqual([{ leg: "fund", hash: "0xfund", nonce: 7 }]);
  });

  test("re-running the identical leg is idempotent rather than a second broadcast", async () => {
    const result = await recordExecutionLeg(db, {
      userId: alice,
      executionId,
      id: "00000000-0000-4000-8000-000000000021",
      leg: "fund",
      signer: "0x3333333333333333333333333333333333333333",
      nonce: 7,
      rawTransaction: "0x02f8",
      hash: "0xfund",
      execution: { status: "pending", stage: "fund" },
      now: new Date(),
    });
    expect(result.replayed).toBe(true);
    expect(result.transaction.id).toBe("00000000-0000-4000-8000-000000000020");
    expect(await journal()).toHaveLength(1);
  });

  test("a second, different transaction for a leg that already has one is refused", async () => {
    await expect(
      recordExecutionLeg(db, {
        userId: alice,
        executionId,
        id: "00000000-0000-4000-8000-000000000022",
        leg: "fund",
        signer: "0x3333333333333333333333333333333333333333",
        nonce: 8,
        rawTransaction: "0x02f9",
        hash: "0xfund-replacement",
        execution: { status: "pending" },
        now: new Date(),
      }),
    ).rejects.toThrow("already has a different fund transaction");
    expect(await journal()).toHaveLength(1);
  });

  test("a reused signer nonce aborts the unit and writes nothing", async () => {
    const before = await journal();
    await expect(
      recordExecutionLeg(db, {
        userId: alice,
        executionId,
        id: "00000000-0000-4000-8000-000000000023",
        leg: "approve",
        signer: "0x3333333333333333333333333333333333333333",
        nonce: 7,
        rawTransaction: "0x02fa",
        hash: "0xapprove",
        execution: { status: "pending", stage: "approve" },
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(NonceReused);
    expect(await journal()).toEqual(before);
    // The execution never advanced to the stage whose transaction could not be journalled.
    expect(await executionStage()).toBe("fund");
  });

  test("a failure after the journal insert rolls the insert back with it", async () => {
    const before = await journal();
    await expect(
      withTenant(db, alice, UNIT_OPTIONS, async (tx: Transaction) => {
        await writeExecutionLeg(tx, {
          userId: alice,
          executionId,
          id: "00000000-0000-4000-8000-000000000024",
          leg: "swap",
          signer: "0x3333333333333333333333333333333333333333",
          nonce: 9,
          rawTransaction: "0x02fb",
          hash: "0xswap",
          execution: { status: "pending", stage: "swap" },
          now: new Date(),
        });
        throw new Error("signer crashed after journalling");
      }),
    ).rejects.toThrow("signer crashed");
    expect(await journal()).toEqual(before);
  });

  test("units compose inside a caller's transaction as one atom", async () => {
    const now = new Date();
    await withTenant(db, alice, UNIT_OPTIONS, async (tx: Transaction) => {
      await writePermissionGrant(tx, {
        userId: alice,
        instanceId,
        permissionId,
        expectedHash: "0xhash-1",
        status: "revoked",
        instance: { mode: "manual", status: "paused" },
        now,
      });
      await writeExecutionLeg(tx, {
        userId: alice,
        executionId,
        id: "00000000-0000-4000-8000-000000000025",
        leg: "refund",
        signer: "0x3333333333333333333333333333333333333333",
        nonce: 11,
        rawTransaction: "0x02fc",
        hash: "0xrefund",
        execution: { status: "refunded", stage: "done" },
        now,
      });
    });
    expect(await permissionRow()).toEqual({ status: "revoked", signature: "0xdeadbeef" });
    expect(await instanceRow()).toEqual({ mode: "manual", status: "paused" });
    expect((await journal()).map((row) => row.leg)).toEqual(["fund", "refund"]);
  });
});
