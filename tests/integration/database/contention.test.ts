import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WorkerStore } from "../../../packages/database/src/index.js";
import {
  UNIT_OPTIONS,
  WriteConflict,
  withTenant,
} from "../../../packages/database/src/transactions/index.js";
import {
  asTenant,
  discardTenants,
  newTenant,
  openPostgres,
  POSTGRES,
  type Postgres,
  pause,
  sqlStateOf,
} from "./harness.js";
import { forceInstance, type InstanceSeed, seedInstance } from "./seed.js";

/**
 * What two sessions do to each other.
 *
 * None of this is observable on a single-session engine. `FOR UPDATE` never waits, `40001` is
 * never raised, and the retry loop in `withTransaction` never runs — so the properties the worker
 * and the API both depend on (one claim wins, the loser waits rather than deadlocks, and a lost
 * race becomes a 503 rather than a corrupted row) are only ever asserted here.
 *
 * Sessions are ordered with an explicit gate and one short pause, never by racing and hoping.
 * The pause exists to let a blocked statement actually reach the lock manager; it is not a poll.
 */

const suite = describe.skipIf(Boolean(POSTGRES.unavailable));

/** Long enough for a blocked statement to be waiting, short beside the pool's 10s timeout. */
const SETTLE_MS = 250;

let pg: Postgres;
/** A second connection, so "two workers" means two sessions and not two closures. */
let other: Postgres;
let alice: string;
const created: string[] = [];

beforeAll(async () => {
  if (POSTGRES.unavailable) return;
  pg = openPostgres();
  other = openPostgres();
  alice = await newTenant(pg);
  created.push(alice);
}, 30_000);

afterAll(async () => {
  if (POSTGRES.unavailable) return;
  await discardTenants(pg, created);
  await Promise.all([pg.close(), other.close()]);
}, 30_000);

/** A lease that always agrees. Leadership is elected by an advisory lock, not by this test. */
const lease = { assert: async () => {} };

async function armedInstance(): Promise<InstanceSeed> {
  const seed = await seedInstance(pg, alice, { mode: "auto" });
  await forceInstance(pg, alice, seed.instance.id, {
    status: "armed",
    mode: "auto",
    eligibleCountry: "GB",
    eligibilityMs: 86_400_000,
  });
  return seed;
}

async function instanceRow(instanceId: string) {
  const rows = await asTenant(pg, alice, (query) =>
    query<{ updated_at: Date; last_tick_at: Date | null; runtime: { totalOrders: number } }>(
      "select updated_at, last_tick_at, runtime from mandate_v2.instances where id = $1",
      [instanceId],
    ),
  );
  return rows[0];
}

suite("two workers claiming one instance", () => {
  test("the second worker waits for the lock and then declines the stale claim", async () => {
    const seed = await armedInstance();
    const first = new WorkerStore(pg.db, lease);
    const second = new WorkerStore(other.db, lease);
    const before = await instanceRow(seed.instance.id);
    if (!before) throw new Error("instance missing");

    const claimed: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    /**
     * The guard `Admission.run` applies, reduced to its two moving parts: take the row lock,
     * then refuse to act on an instance somebody else has already advanced. `updated_at` is the
     * whole optimistic check — the worker read the row before opening this transaction, and a
     * different `updated_at` means that read is now describing a strategy that has moved on.
     */
    const claim = async (store: WorkerStore, label: string, gate?: Promise<void>) =>
      store.write(alice, async (tx) => {
        const current = await store.lockInstance(tx, seed.instance.id);
        if (gate) await gate;
        if (current.updatedAt.getTime() !== before.updated_at.getTime()) return;
        claimed.push(label);
        await tx.execute(
          `update mandate_v2.instances
              set last_tick_at = now(), updated_at = now(), next_tick_at = now() + interval '12 seconds'
            where id = '${seed.instance.id}'`,
        );
      });

    const winner = claim(first, "first", held);
    await pause(SETTLE_MS);
    // Started while the first transaction holds the row lock. This call is now blocked inside
    // PostgreSQL, not spinning in JavaScript.
    const loser = claim(second, "second");
    await pause(SETTLE_MS);
    release();
    await Promise.all([winner, loser]);

    expect(claimed).toEqual(["first"]);
    const after = await instanceRow(seed.instance.id);
    expect(after?.last_tick_at).not.toBeNull();
    expect(after?.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  }, 20_000);

  test("both workers commit when neither invalidates the other's read", async () => {
    // The control for the test above: the lock serializes them, it does not drop work. Two
    // evaluations of two different instances must both land, or the worker would silently skip
    // strategies whenever two ticks overlapped.
    const one = await armedInstance();
    const two = await armedInstance();
    const first = new WorkerStore(pg.db, lease);
    const second = new WorkerStore(other.db, lease);
    const tick = (store: WorkerStore, id: string) =>
      store.write(alice, async (tx) => {
        await store.lockInstance(tx, id);
        await tx.execute(
          `update mandate_v2.instances set last_tick_at = now(), updated_at = now() where id = '${id}'`,
        );
      });
    await Promise.all([tick(first, one.instance.id), tick(second, two.instance.id)]);
    expect((await instanceRow(one.instance.id))?.last_tick_at).not.toBeNull();
    expect((await instanceRow(two.instance.id))?.last_tick_at).not.toBeNull();
  }, 20_000);
});

suite("serialization failures under repeatable read", () => {
  /**
   * Hold the instance row locked from a second session, and hand back a commit function.
   *
   * The unit under test opens its transaction, takes its snapshot on the `set_config` statement,
   * and then blocks on this lock. Committing here after that point is what makes the row it is
   * about to lock newer than its own snapshot — which is precisely the 40001 case.
   */
  async function holdInstanceLock(instanceId: string) {
    const client = await other.pool.connect();
    await client.query("begin");
    await client.query("select set_config('mandate.user_id', $1, true)", [alice]);
    await client.query(
      "update mandate_v2.instances set updated_at = now() where id = $1 and user_id = $2",
      [instanceId, alice],
    );
    return async () => {
      await client.query("commit");
      client.release();
    };
  }

  /**
   * The unit under test: the repository's own mode write, joined to a caller's transaction.
   *
   * `setMode` is what POST /v1/me/automation and arm call. It takes the instance row lock,
   * which is exactly the lock the worker's tick holds, so it is the API write most likely to
   * meet a stale snapshot.
   */
  const flip = (tx: Parameters<Parameters<typeof withTenant>[3]>[0], instanceId: string) =>
    tx.execute(
      `update mandate_v2.instances set mode = 'auto', updated_at = now() where id = '${instanceId}' returning mode`,
    );

  test("the unit is retried and its second attempt commits", async () => {
    const seed = await armedInstance();
    const commit = await holdInstanceLock(seed.instance.id);
    const retries: { attempt: number; sqlState: string }[] = [];

    const unit = withTenant(
      pg.db,
      alice,
      { ...UNIT_OPTIONS, backoffMs: () => 0, onRetry: (info) => retries.push(info) },
      async (tx) => {
        const rows = await tx.execute<{ mode: string }>(
          `select mode from mandate_v2.instances where id = '${seed.instance.id}' for update`,
        );
        await flip(tx, seed.instance.id);
        return rows.rows[0];
      },
    );
    await pause(SETTLE_MS);
    await commit();
    const result = await unit;

    // 40001, not 40P01: nobody deadlocked, the snapshot simply went stale. The unit is safe to
    // repeat because everything it did lives inside `tx`, which is the contract on withTransaction.
    expect(retries).toEqual([{ attempt: 2, sqlState: "40001" }]);
    expect(result?.mode).toBe("auto");
  }, 20_000);

  test("a spent retry budget answers 503 write-conflict, never a half-written row", async () => {
    const seed = await armedInstance();
    const commit = await holdInstanceLock(seed.instance.id);

    const unit = withTenant(
      pg.db,
      alice,
      { ...UNIT_OPTIONS, maxAttempts: 1, backoffMs: () => 0 },
      async (tx) => {
        await tx.execute(
          `select mode from mandate_v2.instances where id = '${seed.instance.id}' for update`,
        );
        await tx.execute(
          `update mandate_v2.instances set mode = 'manual', status = 'paused', updated_at = now() where id = '${seed.instance.id}'`,
        );
      },
    );
    await pause(SETTLE_MS);
    await commit();

    const error = await unit.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(WriteConflict);
    const conflict = error as WriteConflict;
    // 503 and not 409: nothing about the request was wrong, the row was busy, and retrying the
    // same request is the correct client behaviour.
    expect(conflict.status).toBe(503);
    expect(conflict.code).toBe("write-conflict");
    expect(conflict.sqlState).toBe("40001");
    expect(conflict.attempts).toBe(1);
    // The driver error is deliberately not attached, so nothing can log the bound parameters.
    expect((conflict as { cause?: unknown }).cause).toBeUndefined();

    const [row] = await asTenant(pg, alice, (query) =>
      query<{ mode: string; status: string }>(
        "select mode, status from mandate_v2.instances where id = $1",
        [seed.instance.id],
      ),
    );
    expect(row).toMatchObject({ mode: "auto", status: "armed" });
  }, 20_000);

  test("a lifecycle transition racing a mode change waits instead of deadlocking", async () => {
    const seed = await armedInstance();
    // Both paths take the same single row lock. A second table in either one, taken in the
    // other order, is what would turn this into a deadlock PostgreSQL resolves by killing one
    // side at random (40P01).
    const mode = pg.repo.setMode(alice, seed.instance.id, "manual", new Date());
    const transition = other.repo.transition(alice, seed.instance.id, "pause", new Date());
    const outcomes = await Promise.allSettled([mode, transition]);
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") continue;
      expect(sqlStateOf(outcome.reason)).not.toBe("40P01");
      throw outcome.reason;
    }
  }, 20_000);
});
