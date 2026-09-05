import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  connectDatabase,
  type Database,
  type DraftRow,
  type InstanceRow,
  LeadershipLost,
  schema,
  tenant,
  WorkerStore,
} from "@mandate/database";
import { ASSETS, USDC } from "@mandate/evm";
import type { Envelope, Plan, Runtime } from "@mandate/strategy";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  ADMISSION_FAILURE_FLOOR_MS,
  alignTo,
  backoffMs,
  type CadencePolicy,
  type ClaimClient,
  type ClaimConnector,
  claimKey,
  classifyOutcome,
  defaultCadencePolicy,
  InstanceClaims,
  latestOutcome,
  MARKET_WINDOW_MS,
  missedTicks,
  nextDueAt,
  outcomeStreak,
  phaseOffset,
  resolvePolicy,
  Scheduler,
} from "../src/scheduler/index.js";

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture");
  return value;
}

const P = defaultCadencePolicy;
/** Removes jitter so an assertion sees the deterministic term alone. */
const zero = () => 0;
const one = () => 0.999999;

// ---------------------------------------------------------------------------
// Cadence arithmetic. Pure, no database.
// ---------------------------------------------------------------------------

test("phase offsets are stable, bounded, and derived only from the instance id", () => {
  const id = "9f3a6c1e-0000-4000-8000-000000000001";
  expect(phaseOffset(id, 12_000)).toBe(phaseOffset(id, 12_000));
  for (let i = 0; i < 200; i++) {
    const offset = phaseOffset(`instance-${i}`, 12_000);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(12_000);
  }
  expect(phaseOffset("a", 0)).toBe(0);
});

test("a thousand instances armed together do not fire in the same second", () => {
  // The requirement, asserted directly. Jitter is pinned to zero so the spread
  // measured here comes from the deterministic phase alone and cannot be an
  // artefact of Math.random.
  const from = 1_700_000_000_000;
  const seconds = new Map<number, number>();
  for (let i = 0; i < 1000; i++) {
    const at = nextDueAt({
      instanceId: `instance-${i}`,
      from,
      intervalMs: 12_000,
      floorMs: 0,
      outcome: "healthy",
      streak: 0,
      now: from,
      policy: P,
      random: zero,
    }).getTime();
    const second = Math.floor(at / 1000);
    seconds.set(second, (seconds.get(second) ?? 0) + 1);
  }
  // Twelve one-second buckets for a 12s cadence. A scheduler that ignored phase
  // would put all 1000 in one bucket.
  expect(seconds.size).toBeGreaterThanOrEqual(12);
  expect(Math.max(...seconds.values())).toBeLessThan(150);
});

test("due times stay on the instance's own grid, so restarts do not drift", () => {
  const id = "grid-instance";
  const interval = 12_000;
  const phase = phaseOffset(id, interval);
  let from = 1_700_000_000_000;
  for (let tick = 0; tick < 20; tick++) {
    const at = nextDueAt({
      instanceId: id,
      from,
      intervalMs: interval,
      floorMs: 0,
      outcome: "healthy",
      streak: 0,
      now: from,
      policy: P,
      random: zero,
    }).getTime();
    expect((at - phase) % interval).toBe(0);
    // One interval forward, never a doubled or halved gap.
    expect(at - from).toBeGreaterThan(interval / 2);
    expect(at - from).toBeLessThanOrEqual(interval * 1.5);
    from = at;
  }
});

test("alignTo snaps to the nearest grid point, never more than half a period away", () => {
  for (const target of [0, 1, 5_999, 6_000, 6_001, 11_999, 123_456]) {
    const at = alignTo(target, 4_000, 10_000);
    expect((at - 4_000) % 10_000).toBe(0);
    expect(Math.abs(at - target)).toBeLessThanOrEqual(5_000);
  }
  expect(alignTo(1234, 0, 0)).toBe(1234);
});

test("backoff doubles from admission's own 30s failure floor", () => {
  expect(backoffMs(1, 12_000, P, zero)).toBe(ADMISSION_FAILURE_FLOOR_MS);
  expect(backoffMs(2, 12_000, P, zero)).toBe(60_000);
  expect(backoffMs(3, 12_000, P, zero)).toBe(120_000);
  // A slower requested cadence raises the base rather than being overridden.
  expect(backoffMs(1, 300_000, P, zero)).toBe(300_000);
  // Jitter only ever delays; retrying earlier than the 30s already committed
  // would spend RPC budget the worker does not have.
  for (let streak = 1; streak <= 8; streak++)
    expect(backoffMs(streak, 1_000, P, one)).toBeGreaterThanOrEqual(ADMISSION_FAILURE_FLOOR_MS);
});

test("backoff still spreads at the ceiling, where an outage puts every instance", () => {
  // Regression: capping AFTER the jitter collapses the spread exactly when a
  // recovering RPC would be hit by every armed instance at once.
  const low = backoffMs(40, 12_000, P, zero);
  const high = backoffMs(40, 12_000, P, one);
  expect(low).toBe(P.backoffMaxMs);
  expect(high).toBeGreaterThan(low);
  expect(high).toBeLessThanOrEqual(P.backoffMaxMs * 1.5);
  // The exponent is clamped, so an absurd streak stays finite.
  expect(Number.isFinite(backoffMs(10_000, 12_000, P, zero))).toBe(true);
});

test("missed ticks are counted for coalescing, not replayed one by one", () => {
  expect(missedTicks(1000, 1000, 12_000)).toBe(0);
  expect(missedTicks(1000, 1000 + 11_999, 12_000)).toBe(0);
  expect(missedTicks(1000, 1000 + 12_000, 12_000)).toBe(1);
  expect(missedTicks(0, 300_000, 12_000)).toBe(25);
  // An early clock must not produce a negative count.
  expect(missedTicks(50_000, 0, 12_000)).toBe(0);
});

test("outcomes are classified the way their remedies differ", () => {
  expect(classifyOutcome("evaluated")).toBe("healthy");
  expect(classifyOutcome("observation-or-authority-unavailable")).toBe("transient");
  expect(classifyOutcome("observation-expired")).toBe("transient");
  // Not transient: WORKER_EXECUTE only changes on restart, so doubling to half
  // an hour would idle instances long after an operator enabled execution.
  expect(classifyOutcome("execution-disabled")).toBe("policy");
  expect(classifyOutcome("expired")).toBe("terminal");
  expect(classifyOutcome("halted")).toBe("terminal");
  expect(classifyOutcome("eligibility-renewal-required")).toBe("terminal");
  expect(classifyOutcome("deferred")).toBe("scheduler");
  expect(classifyOutcome("late")).toBe("scheduler");
  expect(classifyOutcome("degraded")).toBe("scheduler");
  // A future outcome this build does not know must not read as success.
  expect(classifyOutcome("something-new")).toBe("unknown");
  expect(classifyOutcome(undefined)).toBe("unknown");
});

test("a configuration failure waits a flat minute where a chain failure backs off", () => {
  const from = 1_700_000_000_000;
  const shared = {
    instanceId: "flat",
    from,
    intervalMs: 12_000,
    floorMs: 0,
    streak: 5,
    now: from,
    policy: P,
    random: zero,
  } as const;
  const policy = nextDueAt({ ...shared, outcome: "policy" }).getTime() - from;
  const transient = nextDueAt({ ...shared, outcome: "transient" }).getTime() - from;
  expect(policy).toBe(P.flatBackoffMs);
  expect(transient).toBe(30_000 * 2 ** 4);
  expect(transient).toBeGreaterThan(policy * 5);
});

test("a scheduler-written row is transparent to the failure streak it interrupts", () => {
  const history = [
    "observation-expired",
    "late",
    "observation-or-authority-unavailable",
    "deferred",
    "observation-or-authority-unavailable",
    "evaluated",
  ];
  // Without transparency the interleaved 'late' row would reset the streak to 1
  // and undo the backoff protecting the RPC budget.
  expect(outcomeStreak(history, "transient")).toBe(3);
  expect(outcomeStreak(history, "healthy")).toBe(0);
  expect(latestOutcome(history)).toBe("observation-expired");
  expect(latestOutcome(["deferred", "late"])).toBeUndefined();
});

test("backoff never outlives the strategy's own expiry", () => {
  const now = 1_700_000_000_000;
  const expiresAt = now + 600_000; // ten minutes
  const at = nextDueAt({
    instanceId: "expiring",
    from: now,
    intervalMs: 12_000,
    floorMs: 0,
    outcome: "transient",
    streak: 10, // far past the ten minutes left
    now,
    expiresAt,
    policy: P,
    random: zero,
  }).getTime();
  // Only an evaluation performs the expiry -> ended transition, so a due time
  // past the expiry leaves a dead strategy displayed as armed.
  expect(at).toBeLessThanOrEqual(expiresAt + P.expiryGraceMs);
  expect(at).toBeGreaterThan(now);
  // An already-expired strategy is still scheduled forward, never into the past.
  const dead = nextDueAt({
    instanceId: "expiring",
    from: now,
    intervalMs: 12_000,
    floorMs: 0,
    outcome: "transient",
    streak: 10,
    now,
    expiresAt: now - 86_400_000,
    policy: P,
    random: zero,
  }).getTime();
  expect(dead).toBeGreaterThan(now);
  expect(dead).toBeLessThanOrEqual(now + P.minCadenceMs);
});

test("a cadence floor stretches the requested interval and is reported, not hidden", () => {
  const now = 1_700_000_000_000;
  const at = nextDueAt({
    instanceId: "slow",
    from: now,
    intervalMs: 12_000,
    floorMs: 45_000, // measured cost of an evaluation under load
    outcome: "healthy",
    streak: 0,
    now,
    policy: P,
    random: zero,
  }).getTime();
  expect(at - now).toBeGreaterThan(20_000);
  expect((at - phaseOffset("slow", 45_000)) % 45_000).toBe(0);
});

test("an invalid policy is rejected rather than silently normalised", () => {
  expect(() => resolvePolicy({ backoffFactor: 1 })).toThrow();
  expect(() => resolvePolicy({ streakWindow: 0 })).toThrow();
  expect(resolvePolicy({ flatBackoffMs: 5 }).flatBackoffMs).toBe(5);
  expect(resolvePolicy().backoffFloorMs).toBe(ADMISSION_FAILURE_FLOOR_MS);
  expect(MARKET_WINDOW_MS).toBe(15_000);
});

// ---------------------------------------------------------------------------
// Per-instance claims. A fake connector models PostgreSQL session semantics.
// ---------------------------------------------------------------------------

/** Shared advisory-lock key space; one per "database" in a test. */
class LockSpace {
  readonly owners = new Map<string, FakeClient>();
}

class FakeClient implements ClaimClient {
  readonly queries: { text: string; values: unknown[] }[] = [];
  private readonly mine = new Map<string, number>();
  private handler: ((error: Error) => void) | undefined;
  destroyed = false;
  failQueries = false;
  constructor(private readonly space: LockSpace) {}
  async query<R>(text: string, values: unknown[] = []): Promise<{ rows: R[] }> {
    this.queries.push({ text, values });
    if (this.destroyed) throw new Error("Connection is closed");
    if (this.failQueries) throw new Error("statement timeout");
    const key = String(values[0]);
    if (text.includes("pg_try_advisory_lock")) {
      const owner = this.space.owners.get(key);
      // Postgres session locks are re-entrant within one session and exclusive
      // across sessions.
      if (owner && owner !== this) return { rows: [{ held: false } as R] };
      this.space.owners.set(key, this);
      this.mine.set(key, (this.mine.get(key) ?? 0) + 1);
      return { rows: [{ held: true } as R] };
    }
    if (text.includes("pg_advisory_unlock_all")) {
      this.free();
      return { rows: [] };
    }
    if (text.includes("pg_advisory_unlock")) {
      const depth = (this.mine.get(key) ?? 0) - 1;
      if (depth <= 0) {
        this.mine.delete(key);
        if (this.space.owners.get(key) === this) this.space.owners.delete(key);
      } else this.mine.set(key, depth);
      return { rows: [{ released: true } as R] };
    }
    return { rows: [] };
  }
  release() {
    // A destroyed connection ends its session, and PostgreSQL frees every
    // session advisory lock it held. That is the whole argument for advisory
    // locks over a claimed_until column, so the fake has to model it.
    this.destroyed = true;
    this.free();
  }
  on(_event: "error", listener: (error: Error) => void) {
    this.handler = listener;
    return this;
  }
  /** Simulate the socket dying underneath an idle connection. */
  breakConnection() {
    this.destroyed = true;
    this.free();
    this.handler?.(new Error("connection terminated unexpectedly"));
  }
  private free() {
    for (const key of this.mine.keys())
      if (this.space.owners.get(key) === this) this.space.owners.delete(key);
    this.mine.clear();
  }
}

class FakeConnector implements ClaimConnector {
  readonly clients: FakeClient[] = [];
  attempts = 0;
  failConnect = false;
  constructor(readonly space = new LockSpace()) {}
  async connect(): Promise<ClaimClient> {
    this.attempts++;
    if (this.failConnect) throw new Error("timeout exceeded when trying to connect");
    const client = new FakeClient(this.space);
    this.clients.push(client);
    return client;
  }
  get latest() {
    return required(this.clients.at(-1));
  }
}

type Line = { level: string; object: Record<string, unknown>; message: string | undefined };
function recorder() {
  const lines: Line[] = [];
  const at = (level: string) => (object: object, message?: string) =>
    lines.push({ level, object: object as Record<string, unknown>, message });
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    of: (level: string) => lines.filter((l) => l.level === level),
  };
}

test("two workers cannot hold the same instance at once", async () => {
  const space = new LockSpace();
  const a = new InstanceClaims(new FakeConnector(space), recorder());
  const b = new InstanceClaims(new FakeConnector(space), recorder());
  const id = randomUUID();
  expect(await a.acquire(id)).toEqual({ held: true, generation: 1 });
  expect(await b.acquire(id)).toEqual({ held: false, reason: "contended" });
  // A different instance is unaffected: the lock is per instance, not global.
  expect((await b.acquire(randomUUID())).held).toBe(true);
  await a.release(id, 1);
  expect((await b.acquire(id)).held).toBe(true);
  await a.close();
  await b.close();
});

test("a claim is not re-taken by the process that already holds it", async () => {
  // Session locks are re-entrant, so PostgreSQL alone would hand the same
  // process the same instance twice and need two unlocks to let it go.
  const claims = new InstanceClaims(new FakeConnector(), recorder());
  const id = randomUUID();
  expect((await claims.acquire(id)).held).toBe(true);
  expect(await claims.acquire(id)).toEqual({ held: false, reason: "contended" });
  expect(claims.outstanding).toBe(1);
  await claims.close();
});

test("a dropped claim connection invalidates every outstanding claim", async () => {
  const space = new LockSpace();
  const connector = new FakeConnector(space);
  const log = recorder();
  const claims = new InstanceClaims(connector, log, () => Date.now(), 0);
  const first = randomUUID();
  const second = randomUUID();
  const held = await claims.acquire(first);
  expect(held.held && held.generation).toBe(1);
  await claims.acquire(second);

  connector.latest.breakConnection();
  expect(claims.epoch).toBeGreaterThan(1);
  expect(claims.outstanding).toBe(0);

  // Releasing under the old generation must not unlock on the replacement
  // session, which never held anything.
  await claims.release(first, 1);
  expect(log.of("warn").some((l) => l.message?.includes("lost with its connection"))).toBe(true);

  // The rival can take both immediately: PostgreSQL freed them with the session.
  const rival = new InstanceClaims(new FakeConnector(space), recorder());
  expect((await rival.acquire(first)).held).toBe(true);
  expect((await rival.acquire(second)).held).toBe(true);
  await rival.close();
  await claims.close();
});

test("an unreachable database degrades to unclaimed work and backs off reconnecting", async () => {
  const connector = new FakeConnector();
  connector.failConnect = true;
  let clock = 1_000_000;
  const log = recorder();
  const claims = new InstanceClaims(connector, log, () => clock, 5_000);
  expect(await claims.acquire(randomUUID())).toEqual({ held: false, reason: "unavailable" });
  expect(connector.attempts).toBe(1);
  // A failed pool connect costs the full 5s connectionTimeoutMillis. Retrying
  // it per instance per cycle would stall the tick loop behind a dead database.
  for (let i = 0; i < 20; i++) await claims.acquire(randomUUID());
  expect(connector.attempts).toBe(1);
  clock += 5_001;
  connector.failConnect = false;
  expect((await claims.acquire(randomUUID())).held).toBe(true);
  expect(connector.attempts).toBe(2);
  await claims.close();
});

test("a failing lock query throws the connection away instead of guessing", async () => {
  const connector = new FakeConnector();
  const claims = new InstanceClaims(connector, recorder(), () => Date.now(), 0);
  expect((await claims.acquire(randomUUID())).held).toBe(true);
  connector.latest.failQueries = true;
  expect(await claims.acquire(randomUUID())).toEqual({ held: false, reason: "unavailable" });
  // The session's lock state is unknowable after a timeout, so it is discarded.
  expect(claims.epoch).toBeGreaterThan(1);
  expect(claims.outstanding).toBe(0);
  await claims.close();
});

test("claim keys use the single-bigint lock space, disjoint from leadership's", async () => {
  const key = claimKey("9f3a6c1e-0000-4000-8000-000000000001");
  expect(typeof key).toBe("bigint");
  expect(key).toBe(claimKey("9f3a6c1e-0000-4000-8000-000000000001"));
  expect(key).not.toBe(claimKey("9f3a6c1e-0000-4000-8000-000000000002"));
  // Signed 64-bit, so it always fits PostgreSQL's bigint parameter.
  expect(key).toBeGreaterThanOrEqual(-(2n ** 63n));
  expect(key).toBeLessThan(2n ** 63n);
  // 64 bits of SHA-256 keeps instance-to-instance collisions negligible.
  const keys = new Set<bigint>();
  for (let i = 0; i < 5_000; i++) keys.add(claimKey(`instance-${i}`));
  expect(keys.size).toBe(5_000);
  // The one-argument form is what keeps this key space disjoint from
  // pg_try_advisory_lock(8453, 2026); the native test below proves it for real.
  const connector = new FakeConnector();
  const claims = new InstanceClaims(connector, recorder());
  await claims.acquire("some-instance");
  const issued = required(connector.latest.queries.at(-1));
  expect(issued.text).toContain("pg_try_advisory_lock($1::bigint)");
  expect(issued.values).toHaveLength(1);
  await claims.close();
});

// ---------------------------------------------------------------------------
// Scheduler against a real PostgreSQL (PGlite in memory, or TEST_DATABASE_URL).
// ---------------------------------------------------------------------------

const memory = process.env.TEST_DATABASE_URL ? undefined : new PGlite();
const native = process.env.TEST_DATABASE_URL
  ? connectDatabase(process.env.TEST_DATABASE_URL)
  : undefined;
let db: Database;
let store: WorkerStore;

beforeAll(async () => {
  if (memory) {
    const dir = new URL("../../../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
      await memory.exec(await readFile(new URL(file, dir), "utf8"));
    await memory.exec(
      "create role worker_test nologin; grant usage on schema mandate_v2 to worker_test; grant select, insert, update, delete on all tables in schema mandate_v2 to worker_test; set role worker_test",
    );
    db = drizzle(memory, { schema }) as unknown as Database;
  } else {
    db = required(native).db;
  }
  store = new WorkerStore(db, { assert: async () => {} });
}, 30000);
afterAll(async () => {
  await memory?.close();
  await native?.close();
});

const plan = { params: [], nodes: [], machines: [] } as unknown as Plan;
const runtime: Runtime = {
  machines: {},
  lifetime: "0",
  periodSpent: "0",
  periodStart: 0,
  orders: 0,
  totalOrders: 0,
  lastFires: {},
  halted: false,
};

function envelope(expiresAt: number): Envelope {
  return {
    version: "mandate/2",
    quote: USDC,
    venue: "aerodrome",
    assets: [required(ASSETS[0])],
    caps: {
      lifetime: "100",
      per_order: "10",
      per_period: "100",
      period_secs: 86400,
      max_orders_per_period: 10,
      cooldown_secs: 60,
      expires_at: new Date(expiresAt).toISOString(),
      slippage_bps: 50,
    },
  };
}

type Fixture = { instance: InstanceRow; draft: DraftRow };

/**
 * A minimal armed instance. Rows are inserted directly rather than through
 * Repository: the scheduler reads only the schedule columns and the envelope's
 * expiry, and a full signed-commitment fixture would test Admission, not this.
 */
async function arm(options: {
  now: number;
  dueAt?: number;
  lastTickAt?: number | null;
  intervalMs?: number;
  expiresAt?: number;
  status?: "armed" | "paused" | "ended";
  userId?: string;
}): Promise<Fixture> {
  const now = options.now;
  let userId = options.userId;
  if (!userId) {
    const [user] = await db
      .insert(schema.users)
      .values({ id: randomUUID(), privyDid: `did:privy:${randomUUID().replaceAll("-", "")}` })
      .returning();
    userId = required(user).id;
  }
  const draftId = randomUUID();
  const instanceId = randomUUID();
  const expiresAt = options.expiresAt ?? now + 86_400_000;
  return tenant(db, userId, async (tx) => {
    const [draft] = await tx
      .insert(schema.drafts)
      .values({
        id: draftId,
        userId,
        account: `0x${"ab".repeat(20)}`,
        artifactId: randomUUID(),
        name: "Scheduler fixture",
        mode: "manual",
        plan,
        envelope: envelope(expiresAt),
        reading: "fixture",
        renderText: "fixture",
        renderHash: "fixture",
        confirmMessage: "fixture",
        createdAt: new Date(now),
        expiresAt: new Date(now + 86_400_000),
        consumedAt: new Date(now),
      })
      .returning();
    const [instance] = await tx
      .insert(schema.instances)
      .values({
        id: instanceId,
        userId,
        draftId,
        name: "Scheduler fixture",
        mode: "manual",
        status: options.status ?? "armed",
        signature: `0x${"11".repeat(65)}`,
        runtime,
        tickIntervalMs: options.intervalMs ?? 12_000,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        nextTickAt: new Date(options.dueAt ?? now),
        lastTickAt: options.lastTickAt == null ? null : new Date(options.lastTickAt),
      })
      .returning();
    return { instance: required(instance), draft: required(draft) };
  });
}

/**
 * Make an instance exactly due. Seeding failure history moves next_tick_at with
 * it, which would leave the instance late and — correctly — raise the measured
 * cadence floor. Tests that assert a backoff term isolate it this way.
 */
async function due(fixture: Fixture, at: number) {
  await tenant(db, fixture.instance.userId, (tx) =>
    tx
      .update(schema.instances)
      .set({ nextTickAt: new Date(at) })
      .where(eq(schema.instances.id, fixture.instance.id)),
  );
}

async function read(fixture: Fixture): Promise<InstanceRow> {
  return tenant(db, fixture.instance.userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, fixture.instance.id));
    return required(row);
  });
}

async function evaluations(fixture: Fixture) {
  return tenant(db, fixture.instance.userId, (tx) =>
    tx
      .select()
      .from(schema.evaluations)
      .where(eq(schema.evaluations.instanceId, fixture.instance.id))
      .orderBy(asc(schema.evaluations.at)),
  );
}

/** Write exactly what Admission writes, so the settle guards see their real input. */
async function admissionCommitted(
  fixture: Fixture,
  at: number,
  outcome: string,
  status: "armed" | "paused" | "ended" | "halted" = "armed",
) {
  await tenant(db, fixture.instance.userId, async (tx) => {
    await tx.insert(schema.evaluations).values({
      id: randomUUID(),
      userId: fixture.instance.userId,
      instanceId: fixture.instance.id,
      at: new Date(at),
      outcome,
      admitted: 0,
      refused: null,
      inputs: {},
      notifications: [],
    });
    const failed = outcome !== "evaluated";
    await tx
      .update(schema.instances)
      .set({
        status,
        lastTickAt: new Date(at),
        nextTickAt: new Date(
          at +
            (failed
              ? Math.max(ADMISSION_FAILURE_FLOOR_MS, fixture.instance.tickIntervalMs)
              : fixture.instance.tickIntervalMs),
        ),
      })
      .where(eq(schema.instances.id, fixture.instance.id));
  });
}

function scheduler(options: {
  clock: () => number;
  connector?: ClaimConnector;
  store?: WorkerStore;
  policy?: Partial<CadencePolicy>;
  random?: () => number;
}) {
  const log = recorder();
  const instance = new Scheduler({
    store: options.store ?? store,
    connector: options.connector ?? new FakeConnector(),
    log,
    now: options.clock,
    random: options.random ?? zero,
    policy: options.policy,
  });
  return { scheduler: instance, log };
}

test("a healthy tick is rescheduled onto its grid without touching updatedAt", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  const { scheduler: s } = scheduler({ clock: () => clock });

  const claim = required(await s.claim(fixture.instance, fixture.draft));
  clock += 5_000;
  await admissionCommitted(fixture, clock, "evaluated");
  await s.settle(claim);

  const after = await read(fixture);
  const phase = phaseOffset(fixture.instance.id, 12_000);
  expect((after.nextTickAt.getTime() - phase) % 12_000).toBe(0);
  expect(after.nextTickAt.getTime()).toBeGreaterThan(clock);
  // A scheduling adjustment is not a state transition: updatedAt is the
  // owner-visible mutation timestamp and Admission compares it for staleness.
  expect(after.updatedAt.getTime()).toBe(fixture.instance.updatedAt.getTime());
  expect(s.stats().rescheduled).toBe(1);
  expect(s.stats().claimed).toBe(1);
  await s.close();
});

test("settle leaves a due time alone when the API re-armed during the tick", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  const { scheduler: s, log } = scheduler({ clock: () => clock });

  const claim = required(await s.claim(fixture.instance, fixture.draft));
  clock += 5_000;
  await admissionCommitted(fixture, clock, "evaluated");
  // Repository.transition("arm") sets next_tick_at = now to force an immediate
  // evaluation. Clobbering it would make the user's Arm button look dead.
  const armedAt = clock + 500;
  await tenant(db, fixture.instance.userId, (tx) =>
    tx
      .update(schema.instances)
      .set({ nextTickAt: new Date(armedAt), updatedAt: new Date(armedAt) })
      .where(eq(schema.instances.id, fixture.instance.id)),
  );
  await s.settle(claim);

  expect((await read(fixture)).nextTickAt.getTime()).toBe(armedAt);
  expect(s.stats().rescheduled).toBe(0);
  expect(log.of("debug").some((l) => l.message?.includes("rescheduled concurrently"))).toBe(true);
  await s.close();
});

test("a tick that committed no evaluation leaves a durable deferral, not a silence", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  // Five minutes late with a 12s cadence: twenty-five scheduled evaluations
  // never happened.
  const dueAt = clock - 300_000;
  const fixture = await arm({ now: clock, dueAt });
  const { scheduler: s } = scheduler({ clock: () => clock });

  const claim = required(await s.claim(fixture.instance, fixture.draft));
  expect(claim.missedTicks).toBe(25);
  expect(claim.latenessMs).toBe(300_000);
  clock += 1_000;
  // Admission threw before its write transaction: lastTickAt never moved.
  await s.settle(claim);

  const rows = await evaluations(fixture);
  const late = required(rows.find((r) => r.outcome === "late"));
  const deferred = required(rows.find((r) => r.outcome === "deferred"));
  expect(late.admitted).toBe(0);
  // `inputs` is rendered as observed prices; a deferral observed none.
  expect(late.inputs).toEqual({});
  expect(late.notifications.some((n) => n.includes("coalesced, not replayed"))).toBe(true);
  expect(required(late.refused)).toContain("300.0s");
  expect(required(deferred.refused)).toContain("skipped");

  const after = await read(fixture);
  // Backed off past admission's own failure floor rather than retried at once.
  expect(after.nextTickAt.getTime()).toBeGreaterThanOrEqual(clock + ADMISSION_FAILURE_FLOOR_MS);
  expect(s.stats().records.written).toBe(2);
  await s.close();
});

test("repeated no-evaluation ticks back off exponentially", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  const { scheduler: s } = scheduler({ clock: () => clock });
  const waits: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await read(fixture);
    const claim = required(await s.claim(current, fixture.draft));
    await s.settle(claim);
    waits.push((await read(fixture)).nextTickAt.getTime() - clock);
    // Jump to the new due time so the next attempt is genuinely due.
    clock = (await read(fixture)).nextTickAt.getTime();
  }
  expect(waits).toEqual([30_000, 60_000, 120_000, 240_000]);
  await s.close();
});

test("a durable transient streak drives backoff after a committed failure", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  const { scheduler: s } = scheduler({ clock: () => clock });
  // Three earlier failures already on the record.
  for (let i = 3; i >= 1; i--)
    await admissionCommitted(fixture, clock - i * 60_000, "observation-or-authority-unavailable");
  await due(fixture, clock);

  const current = await read(fixture);
  const claim = required(await s.claim(current, fixture.draft));
  clock += 2_000;
  await admissionCommitted(fixture, clock, "observation-or-authority-unavailable");
  await s.settle(claim);

  // Streak of four: 30s doubled three times.
  expect((await read(fixture)).nextTickAt.getTime() - clock).toBe(240_000);
  await s.close();
});

test("execution-disabled waits a flat minute so enabling execution is not punished", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  const { scheduler: s } = scheduler({ clock: () => clock });
  for (let i = 6; i >= 1; i--)
    await admissionCommitted(fixture, clock - i * 90_000, "execution-disabled");
  await due(fixture, clock);

  const current = await read(fixture);
  const claim = required(await s.claim(current, fixture.draft));
  clock += 1_000;
  await admissionCommitted(fixture, clock, "execution-disabled");
  await s.settle(claim);

  // Seven consecutive failures. Exponential would be half an hour; an operator
  // flipping WORKER_EXECUTE must not wait that long.
  expect((await read(fixture)).nextTickAt.getTime() - clock).toBe(60_000);
  await s.close();
});

test("backoff is clamped so an expiring strategy still reaches its terminal tick", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const expiresAt = clock + 120_000; // two minutes left
  const fixture = await arm({ now: clock, dueAt: clock, expiresAt });
  const { scheduler: s } = scheduler({ clock: () => clock });
  for (let i = 8; i >= 1; i--)
    await admissionCommitted(fixture, clock - i * 200_000, "observation-or-authority-unavailable");

  const current = await read(fixture);
  const claim = required(await s.claim(current, fixture.draft));
  clock += 1_000;
  await admissionCommitted(fixture, clock, "observation-or-authority-unavailable");
  await s.settle(claim);

  const at = (await read(fixture)).nextTickAt.getTime();
  // Unclamped this streak is well past half an hour, long after the expiry.
  expect(at).toBeLessThanOrEqual(expiresAt + P.expiryGraceMs);
  expect(at).toBeGreaterThan(clock);
  await s.close();
});

test("an instance admission moved out of armed is not resurrected", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  const { scheduler: s } = scheduler({ clock: () => clock });
  const claim = required(await s.claim(fixture.instance, fixture.draft));
  clock += 3_000;
  await admissionCommitted(fixture, clock, "eligibility-renewal-required", "paused");
  const paused = await read(fixture);
  await s.settle(claim);
  const after = await read(fixture);
  expect(after.status).toBe("paused");
  expect(after.nextTickAt.getTime()).toBe(paused.nextTickAt.getTime());
  expect(s.stats().rescheduled).toBe(0);
  await s.close();
});

test("owner-visible lapse records are rate limited but the operator signal is not", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock - 300_000, intervalMs: 12_000 });
  const { scheduler: s, log } = scheduler({ clock: () => clock });

  for (let i = 0; i < 3; i++) {
    const current = await read(fixture);
    const claim = required(await s.claim(current, fixture.draft));
    await s.abandon(claim);
    clock += 1_000;
    // Force it due again without changing anything else.
    await tenant(db, fixture.instance.userId, (tx) =>
      tx
        .update(schema.instances)
        .set({ nextTickAt: new Date(clock - 300_000) })
        .where(eq(schema.instances.id, fixture.instance.id)),
    );
  }
  const rows = (await evaluations(fixture)).filter((r) => r.outcome === "late");
  // One row per instance per max(interval, 60s): three lapses inside a minute
  // must not bury the real evaluations in the owner's history.
  expect(rows).toHaveLength(1);
  expect(s.stats().records.suppressed).toBe(2);
  // But every single lapse is on the operator's log.
  expect(log.of("warn").filter((l) => l.message?.includes("did not run on time"))).toHaveLength(3);
  await s.close();
});

test("aggregate pressure explains a lapse with the owner's own due count", async () => {
  const clock = Date.parse("2026-03-02T15:00:00.000Z");
  const first = await arm({ now: clock, dueAt: clock - 600_000 });
  const userId = first.instance.userId;
  await arm({ now: clock, dueAt: clock - 600_000, userId });
  await arm({ now: clock, dueAt: clock - 600_000, userId });
  const { scheduler: s } = scheduler({ clock: () => clock });
  await s.abandon(required(await s.claim(first.instance, first.draft)));
  const late = required((await evaluations(first)).find((r) => r.outcome === "late"));
  expect(late.notifications.some((n) => n.includes("3 of your armed strategies"))).toBe(true);
  await s.close();
});

test("a degraded cadence is disclosed rather than silently applied", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock, intervalMs: 12_000 });
  // A measured evaluation cost above the requested cadence: the RPC budget
  // (1200ms per request, process-wide) cannot sustain 12s here.
  const { scheduler: s } = scheduler({ clock: () => clock });
  const claim = required(await s.claim(fixture.instance, fixture.draft));
  clock += 40_000; // this evaluation took forty seconds
  await admissionCommitted(fixture, clock, "evaluated");
  await s.settle(claim);

  const stats = s.stats();
  expect(stats.cadenceFloorMs).toBeGreaterThan(12_000);
  const degraded = required((await evaluations(fixture)).find((r) => r.outcome === "degraded"));
  expect(required(degraded.refused)).toContain("cannot be sustained");
  expect((await read(fixture)).nextTickAt.getTime() - clock).toBeGreaterThan(12_000);
  await s.close();
});

test("a contended instance is skipped, and an unclaimable database still evaluates", async () => {
  const clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  const space = new LockSpace();
  const a = scheduler({ clock: () => clock, connector: new FakeConnector(space) });
  const b = scheduler({ clock: () => clock, connector: new FakeConnector(space) });

  const held = required(await a.scheduler.claim(fixture.instance, fixture.draft));
  expect(held.exclusive).toBe(true);
  expect(await b.scheduler.claim(fixture.instance, fixture.draft)).toBeUndefined();
  expect(b.scheduler.stats().contended).toBe(1);
  await a.scheduler.abandon(held);

  // Losing the claim connection must degrade to duplicated RPC, never to a
  // stopped scheduler: Admission's own compare-and-set is the safety mechanism.
  const broken = new FakeConnector();
  broken.failConnect = true;
  const c = scheduler({ clock: () => clock, connector: broken });
  const unclaimed = required(await c.scheduler.claim(fixture.instance, fixture.draft));
  expect(unclaimed.exclusive).toBe(false);
  expect(c.scheduler.stats().unclaimed).toBe(1);
  await a.scheduler.close();
  await b.scheduler.close();
  await c.scheduler.close();
});

test("an instance whose due time cannot be written is gated, not retried every cycle", async () => {
  let clock = Date.parse("2026-03-02T15:00:00.000Z");
  const fixture = await arm({ now: clock, dueAt: clock });
  // Leadership loss: every worker write transaction is fenced.
  const fenced = new WorkerStore(db, {
    assert: async () => {
      throw new LeadershipLost();
    },
  });
  const { scheduler: s, log } = scheduler({ clock: () => clock, store: fenced });

  const claim = required(await s.claim(fixture.instance, fixture.draft));
  await s.settle(claim);
  expect(s.stats().settleFailures).toBe(1);
  expect(
    log.of("error").some((l) => l.message?.includes("could not write the next due time")),
  ).toBe(true);

  // Without the gate this instance is still due and burns the RPC budget on
  // every 2s cycle forever.
  clock += 1_000;
  expect(await s.claim(await read(fixture), fixture.draft)).toBeUndefined();
  expect(s.stats().gated).toBe(1);
  // The gate expires, so a database that recovers is not locked out.
  clock += ADMISSION_FAILURE_FLOOR_MS;
  expect(await s.claim(await read(fixture), fixture.draft)).toBeDefined();
  await s.close();
});

test("readiness refuses to start on a clock that disagrees with the database", async () => {
  const skewed = new Scheduler({
    store,
    connector: new FakeConnector(),
    log: recorder(),
    now: () => Date.now() + 60_000,
  });
  await expect(skewed.ready()).rejects.toThrow(/clock differs/);
  await skewed.close();

  const healthy = new Scheduler({
    store,
    connector: new FakeConnector(),
    log: recorder(),
    // A generous budget: PGlite readiness on a loaded CI box is not a skewed clock.
    policy: { maxClockSkewMs: 5_000 },
  });
  expect(await healthy.ready()).toBe(true);
  await healthy.close();
});

// ---------------------------------------------------------------------------
// Native PostgreSQL only. PGlite is a single session and cannot show contention
// between connections, and the lock-space claim is too important to assert in a
// comment.
// ---------------------------------------------------------------------------

test.skipIf(!native)(
  "instance claims cannot collide with the leadership lock, and do exclude each other",
  async () => {
    const pool = required(native).pool;
    const leader = await pool.connect();
    const worker = await pool.connect();
    const rival = await pool.connect();
    try {
      const held = await leader.query<{ held: boolean }>(
        "select pg_try_advisory_lock(8453, 2026) as held",
      );
      expect(held.rows[0]?.held).toBe(true);
      // The same 64 bits, in the single-bigint key space. PostgreSQL gives the
      // two forms different lock tags, so this must succeed.
      const packed = ((8453n << 32n) | 2026n).toString();
      const collide = await worker.query<{ held: boolean }>(
        "select pg_try_advisory_lock($1::bigint) as held",
        [packed],
      );
      expect(collide.rows[0]?.held).toBe(true);
      await worker.query("select pg_advisory_unlock($1::bigint)", [packed]);

      const key = claimKey(randomUUID()).toString();
      const mine = await worker.query<{ held: boolean }>(
        "select pg_try_advisory_lock($1::bigint) as held",
        [key],
      );
      expect(mine.rows[0]?.held).toBe(true);
      const theirs = await rival.query<{ held: boolean }>(
        "select pg_try_advisory_lock($1::bigint) as held",
        [key],
      );
      expect(theirs.rows[0]?.held).toBe(false);
      // A dying session frees its locks with no janitor and no lease expiry.
      worker.release(true);
      const after = await rival.query<{ held: boolean }>(
        "select pg_try_advisory_lock($1::bigint) as held",
        [key],
      );
      expect(after.rows[0]?.held).toBe(true);
      await rival.query("select pg_advisory_unlock_all()");
      await leader.query("select pg_advisory_unlock(8453, 2026)");
    } finally {
      leader.release(true);
      rival.release(true);
    }
  },
);

test.skipIf(!native)("two schedulers never evaluate one instance at the same time", async () => {
  const pool = required(native).pool;
  const clock = Date.now();
  const fixture = await arm({ now: clock, dueAt: clock });
  const a = new Scheduler({ store, connector: pool, log: recorder(), now: () => clock });
  const b = new Scheduler({ store, connector: pool, log: recorder(), now: () => clock });
  try {
    const [first, second] = await Promise.all([
      a.claim(fixture.instance, fixture.draft),
      b.claim(fixture.instance, fixture.draft),
    ]);
    // Exactly one of the two, whichever won the race.
    expect([first, second].filter(Boolean)).toHaveLength(1);
  } finally {
    await a.close();
    await b.close();
  }
});
