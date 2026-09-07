import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  NonceReused,
  recordExecutionLeg,
  recordPermissionGrant,
  UNIT_OPTIONS,
  withTenant,
  withTransaction,
  writeExecutionLeg,
} from "../../../packages/database/src/transactions/index.js";
import {
  asTenant,
  countOf,
  discardTenants,
  newTenant,
  openPostgres,
  POSTGRES,
  type Postgres,
} from "./harness.js";
import { type InstanceSeed, seedExecution, seedInstance, seedPermission, txHash } from "./seed.js";

/**
 * The two units of work, against the constraints and triggers they were written for.
 *
 * `writeExecutionLeg`'s idempotency is the `execution_leg` unique index, and `signer_nonce` is
 * what stops one key signing two live transactions. Neither is a code path — they are database
 * objects, and the unit's behaviour is entirely a function of which SQLSTATE the server returns.
 * Testing them against a fake asserts what the author believed PostgreSQL does.
 */

const suite = describe.skipIf(Boolean(POSTGRES.unavailable));

let pg: Postgres;
let alice: string;
let bob: string;
const created: string[] = [];

beforeAll(async () => {
  if (POSTGRES.unavailable) return;
  pg = openPostgres();
  alice = await newTenant(pg);
  bob = await newTenant(pg);
  created.push(alice, bob);
}, 30_000);

afterAll(async () => {
  if (POSTGRES.unavailable) return;
  await discardTenants(pg, created);
  await pg.close();
}, 30_000);

/** Journal rows for one order, ordered the way the lifecycle reads them. */
async function journal(userId: string, executionId: string) {
  return asTenant(pg, userId, (query) =>
    query<{ leg: string; hash: string; status: string; nonce: number }>(
      "select leg, hash, status, nonce from mandate_v2.transactions where execution_id = $1 order by nonce",
      [executionId],
    ),
  );
}

async function executionState(userId: string, executionId: string) {
  const rows = await asTenant(pg, userId, (query) =>
    query<{ status: string; stage: string; tx_hash: string | null }>(
      "select status, stage, tx_hash from mandate_v2.executions where id = $1",
      [executionId],
    ),
  );
  return rows[0];
}

/** A `fund` leg for a seeded order, with a nonce nothing else in this run will claim. */
function fundLeg(userId: string, executionId: string, nonce: number, hash = txHash()) {
  return {
    userId,
    executionId,
    id: randomUUID(),
    leg: "fund" as const,
    signer: `0x${"2".repeat(40)}`,
    nonce,
    rawTransaction: `0x02${"ab".repeat(64)}`,
    hash,
    evidence: {
      amount: "10000000",
      recipient: `0x${"2".repeat(40)}`,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    execution: { status: "pending" as const, stage: "fund", txHash: hash },
    now: new Date(),
  };
}

/** Nonces are globally unique per signer, so every test has to claim its own slice. */
let nextNonce = Math.floor(Math.random() * 1_000_000) * 100;
const nonce = () => nextNonce++;

suite("writeExecutionLeg", () => {
  let seed: InstanceSeed;
  beforeAll(async () => {
    seed = await seedInstance(pg, alice, { mode: "auto" });
  });

  test("journalling the same leg twice writes one row and reports the replay", async () => {
    const order = await seedExecution(pg, alice, seed);
    const leg = fundLeg(alice, order.id, nonce());

    const first = await recordExecutionLeg(pg.db, leg);
    expect(first.replayed).toBe(false);
    expect(first.execution.status).toBe("pending");

    // Not a second call by a confused caller: this is the crash-between-commit-and-acknowledge
    // path, where the process comes back and re-derives exactly the same leg.
    const second = await recordExecutionLeg(pg.db, leg);
    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await journal(alice, order.id)).toHaveLength(1);
  });

  test("a second, different transaction for the same leg is refused outright", async () => {
    const order = await seedExecution(pg, alice, seed);
    const first = fundLeg(alice, order.id, nonce());
    await recordExecutionLeg(pg.db, first);

    // Same leg, new bytes and a new nonce: this is a re-sign, which is the double-broadcast
    // this constraint exists to prevent. Overwriting would leave one of the two unaccounted for.
    const resigned = fundLeg(alice, order.id, nonce());
    await expect(recordExecutionLeg(pg.db, resigned)).rejects.toThrow(
      /already has a different fund transaction/,
    );
    const rows = await journal(alice, order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).toBe(first.hash);
  });

  test("a reused signer nonce aborts the unit with nothing written", async () => {
    const shared = nonce();
    const first = await seedExecution(pg, alice, seed);
    await recordExecutionLeg(pg.db, fundLeg(alice, first.id, shared));

    const second = await seedExecution(pg, alice, seed);
    const collision = fundLeg(alice, second.id, shared);
    await expect(recordExecutionLeg(pg.db, collision)).rejects.toBeInstanceOf(NonceReused);

    // The insert runs before the execution update precisely so this is true: the order is still
    // `admitted`, not a `pending` row the journal cannot account for.
    expect(await journal(alice, second.id)).toHaveLength(0);
    expect(await executionState(alice, second.id)).toMatchObject({
      status: "admitted",
      stage: "fund",
      tx_hash: null,
    });
  });

  test("the nonce index is global, so another tenant's row still blocks the write", async () => {
    const shared = nonce();
    const mine = await seedExecution(pg, alice, seed);
    await recordExecutionLeg(pg.db, fundLeg(alice, mine.id, shared));

    const theirSeed = await seedInstance(pg, bob, { mode: "auto" });
    const theirs = await seedExecution(pg, bob, theirSeed);
    // Row level security hides alice's row from bob, but a unique index is not a policy: the
    // signing key is shared across every owner, so two tenants cannot both hold nonce N.
    await expect(recordExecutionLeg(pg.db, fundLeg(bob, theirs.id, shared))).rejects.toBeInstanceOf(
      NonceReused,
    );
  });

  test("an order that is not the caller's is a 404 before anything is inserted", async () => {
    const order = await seedExecution(pg, alice, seed);
    await expect(recordExecutionLeg(pg.db, fundLeg(bob, order.id, nonce()))).rejects.toMatchObject({
      status: 404,
    });
  });
});

suite("units compose into the caller's transaction", () => {
  test("a unit joined to an outer transaction is rolled back with it", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const order = await seedExecution(pg, alice, seed);
    const leg = fundLeg(alice, order.id, nonce());

    await expect(
      withTenant(pg.db, alice, UNIT_OPTIONS, async (tx) => {
        const result = await writeExecutionLeg(tx, leg);
        expect(result.replayed).toBe(false);
        // Everything the unit did is visible inside the transaction that did it...
        throw new Error("caller failed after journalling");
      }),
    ).rejects.toThrow("caller failed after journalling");

    // ...and none of it survives. There is no savepoint on the nested path, which is the point:
    // a savepoint would let a caller swallow a failed unit and commit the rest, and that is
    // exactly how an executions row gets written without its transactions row.
    expect(await journal(alice, order.id)).toHaveLength(0);
    expect(await executionState(alice, order.id)).toMatchObject({ status: "admitted" });
  });

  test("a unit refuses to run under weaker isolation than it was written for", async () => {
    await withTransaction(pg.db, { isolationLevel: "read committed" }, async (tx) => {
      // `transaction_isolation` is read from the live transaction, so only a real server can
      // answer this. The failure is loud on purpose: a unit silently downgraded to read
      // committed is a lost update that only appears under load.
      await expect(
        withTransaction(tx, { isolationLevel: "serializable" }, async () => "unreachable"),
      ).rejects.toThrow(
        /requires serializable isolation but the open transaction is read committed/,
      );
    });
  });

  test("a nested unit may not re-point an open transaction at another tenant", async () => {
    await withTenant(pg.db, alice, {}, async (tx) => {
      await expect(withTenant(tx, bob, {}, async () => "unreachable")).rejects.toThrow(
        /Refusing to change the tenant of an open transaction/,
      );
      // The outer transaction is unharmed: the refusal happened before any failing statement.
      const rows = await tx.execute<{ current: string }>(
        "select current_setting('mandate.user_id', true) as current",
      );
      expect(rows.rows[0]?.current).toBe(alice);
    });
  });
});

suite("writePermissionGrant", () => {
  test("the permission and the instance move in one commit", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const permission = await seedPermission(pg, alice, seed, {
      status: "prepared",
      signature: null,
    });
    const now = new Date();
    const { permission: written, instance } = await recordPermissionGrant(pg.db, {
      userId: alice,
      instanceId: seed.instance.id,
      permissionId: permission.id,
      expectedHash: permission.hash,
      status: "active",
      signature: `0x${"ab".repeat(65)}`,
      instance: { mode: "auto" },
      now,
    });
    expect(written.status).toBe("active");
    expect(instance.mode).toBe("auto");

    const [row] = await asTenant(pg, alice, (query) =>
      query<{ status: string; mode: string }>(
        `select p.status, i.mode from mandate_v2.permissions p
           join mandate_v2.instances i on i.id = p.instance_id
          where p.id = $1`,
        [permission.id],
      ),
    );
    // A permission that says "active" beside an instance that still says "manual" is authority
    // nobody will use; the reverse is an instance the worker will try to execute with nothing
    // behind it. Neither is reachable if this is one commit.
    expect(row).toMatchObject({ status: "active", mode: "auto" });
  });

  test("a permission re-prepared while the request was in flight is refused, unwritten", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const permission = await seedPermission(pg, alice, seed, {
      status: "prepared",
      signature: null,
    });
    await expect(
      recordPermissionGrant(pg.db, {
        userId: alice,
        instanceId: seed.instance.id,
        permissionId: permission.id,
        // A different digest is a different authorization, not a stale copy of this one.
        expectedHash: `0x${"00".repeat(32)}`,
        status: "active",
        signature: `0x${"ab".repeat(65)}`,
        instance: { mode: "auto" },
        now: new Date(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "permission-state" });

    const [row] = await asTenant(pg, alice, (query) =>
      query<{ status: string; signature: string | null; mode: string }>(
        `select p.status, p.signature, i.mode from mandate_v2.permissions p
           join mandate_v2.instances i on i.id = p.instance_id
          where p.id = $1`,
        [permission.id],
      ),
    );
    expect(row).toMatchObject({ status: "prepared", signature: null, mode: "manual" });
  });

  test("a grant rolled back by its caller leaves neither half behind", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const permission = await seedPermission(pg, alice, seed, {
      status: "prepared",
      signature: null,
    });
    await expect(
      withTenant(pg.db, alice, UNIT_OPTIONS, async (tx) => {
        await recordPermissionGrant(tx, {
          userId: alice,
          instanceId: seed.instance.id,
          permissionId: permission.id,
          expectedHash: permission.hash,
          status: "active",
          signature: `0x${"ab".repeat(65)}`,
          instance: { mode: "auto", status: "armed" },
          now: new Date(),
        });
        throw new Error("caller failed after granting");
      }),
    ).rejects.toThrow("caller failed after granting");

    const [row] = await asTenant(pg, alice, (query) =>
      query<{ status: string; signature: string | null; mode: string; istatus: string }>(
        `select p.status, p.signature, i.mode, i.status as istatus from mandate_v2.permissions p
           join mandate_v2.instances i on i.id = p.instance_id
          where p.id = $1`,
        [permission.id],
      ),
    );
    expect(row).toMatchObject({
      status: "prepared",
      signature: null,
      mode: "manual",
      istatus: "paused",
    });
  });
});

suite("the journal is append-only", () => {
  test("a signed transaction cannot be deleted, by anyone, including the writer", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const order = await seedExecution(pg, alice, seed);
    const leg = fundLeg(alice, order.id, nonce());
    await recordExecutionLeg(pg.db, leg);

    const attempt = asTenant(pg, alice, (query) =>
      query("delete from mandate_v2.transactions where hash = $1", [leg.hash]),
    );
    // 23514 from `protect_transaction`. This is why `discardTenant` cannot fully clean up after
    // an execution suite, and it is the correct trade: evidence of a broadcast outlives the run.
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
    expect(await journal(alice, order.id)).toHaveLength(1);
  });

  test("a settled transaction cannot be re-settled with a different verdict", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const order = await seedExecution(pg, alice, seed);
    const leg = fundLeg(alice, order.id, nonce());
    await recordExecutionLeg(pg.db, leg);

    // signed -> confirmed is the one transition the trigger allows.
    await asTenant(pg, alice, (query) =>
      query(
        "update mandate_v2.transactions set status = 'confirmed', confirmed_at = now() where hash = $1",
        [leg.hash],
      ),
    );
    const attempt = asTenant(pg, alice, (query) =>
      query("update mandate_v2.transactions set status = 'reverted' where hash = $1", [leg.hash]),
    );
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
  });

  test("an admitted order's size and pair are immutable once written", async () => {
    const seed = await seedInstance(pg, alice, { mode: "auto" });
    const order = await seedExecution(pg, alice, seed);
    const attempt = asTenant(pg, alice, (query) =>
      query("update mandate_v2.executions set amount_in = '999000000' where id = $1", [order.id]),
    );
    // The intent the user's rules produced is not editable by anything downstream of admission.
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
    const rows = await asTenant(pg, alice, (query) =>
      countOf(
        query,
        "select count(*) from mandate_v2.executions where id = $1 and amount_in = $2",
        [order.id, "10000000"],
      ),
    );
    expect(rows).toBe(1);
  });
});
