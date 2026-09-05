import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadWorkerConfig } from "@mandate/config";
import {
  connectDatabase,
  type Database,
  type ExecutionRow,
  LeadershipLost,
  Repository,
  schema,
  tenant,
  WorkerStore,
} from "@mandate/database";
import { ASSETS, USDC } from "@mandate/evm";
import {
  Admission,
  type Executor,
  Lifecycle,
  type Observation,
  type Observations,
  type Prepared,
} from "@mandate/execution";
import { digest, type Envelope, type Plan, review } from "@mandate/strategy";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWorkerJobs, dispatch } from "../src/jobs/index.js";
import type { JobDependencies, JobLogger, JobResult } from "../src/jobs/types.js";

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture");
  return value;
}

// Distinctive bytes: every assertion that logs must never carry a signed transaction
// searches for this exact string.
const RAW = `0x02f8${"ab".repeat(48)}`;

const memory = process.env.TEST_DATABASE_URL ? undefined : new PGlite();
const native = process.env.TEST_DATABASE_URL
  ? connectDatabase(process.env.TEST_DATABASE_URL)
  : undefined;
let db: Database;
let store: WorkerStore;
let repo: Repository;
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const origin = "http://localhost:3000";

/** Counts every observation so a test can assert a precondition spent no RPC at all. */
class FakeChain implements Observations, Executor {
  snapshots = 0;
  authorizations = 0;
  prepared: string[] = [];
  sent: string[] = [];
  results = new Map<string, Observation>();
  failPrepare: string | undefined;
  verifyMessage(...args: Parameters<Observations["verifyMessage"]>) {
    const [address, message, signature] = args;
    return verifyMessage({ address, message, signature });
  }
  async authorize() {
    this.authorizations += 1;
  }
  async snapshot() {
    this.snapshots += 1;
    return {
      at: Date.now(),
      feeds: { "oracle:AAPLc": "200", "dex:AAPLc": "200" },
      portfolio: { equity: "100", positions: { [required(ASSETS[0]).token.toLowerCase()]: "0" } },
    };
  }
  async prepare(leg: Parameters<Executor["prepare"]>[0]): Promise<Prepared> {
    if (leg === this.failPrepare) throw new Error("Live execution disabled");
    this.prepared.push(leg);
    return {
      // A real worker signs with one fixed key; the journal's unique (signer, nonce) is
      // global, so fixtures across tests use distinct signers to stay independent.
      signer: `0x${randomUUID().replaceAll("-", "")}00000000`,
      nonce: this.prepared.length,
      rawTransaction: RAW,
      hash: `0x${randomUUID().replaceAll("-", "")}`,
      evidence: null,
    };
  }
  async observe(tx: Parameters<Executor["observe"]>[0]) {
    return this.results.get(tx.hash) ?? "pending";
  }
  async broadcast(tx: Parameters<Executor["broadcast"]>[0]) {
    this.sent.push(tx.rawTransaction);
  }
}

type Line = { level: string; body: object; message: string | undefined };
function recorder(): JobLogger & { lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (body: object, message?: string) =>
    void lines.push({ level, body, message });
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

let clock = new Date();
function deps(chain: FakeChain, options: Partial<JobDependencies> = {}): JobDependencies {
  return {
    store,
    admission: new Admission(store, chain, origin, true, ["NG"]),
    lifecycle: new Lifecycle(store, chain, 60000),
    executeEnabled: true,
    log: recorder(),
    now: () => clock,
    ...options,
  };
}

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
  repo = new Repository(db);
  store = new WorkerStore(db, { assert: async () => {} });
}, 30000);
afterAll(async () => {
  await memory?.close();
  await native?.close();
});

/**
 * The signer is global, so an order left outstanding by one test blocks admission and
 * execution in every later one. Cancelling them between tests reproduces a worker that
 * starts with nothing in flight.
 */
async function quiesce() {
  clock = new Date();
  for (const owner of await db.select({ id: schema.users.id }).from(schema.users))
    await tenant(db, owner.id, (tx) =>
      tx
        .update(schema.executions)
        .set({ status: "cancelled" })
        .where(inArray(schema.executions.status, ["admitted", "pending", "recovery_required"])),
    );
}
beforeEach(quiesce);

async function fixture(mode: "auto" | "manual" = "manual") {
  const user = await repo.resolvePrivyUser(`did:privy:${randomUUID().replaceAll("-", "")}`);
  const plan: Plan = {
    params: [],
    nodes: [
      {
        id: "cheap",
        op: "lt",
        args: [
          { kind: "feed", feed: "oracle:AAPLc" },
          { kind: "const", value: "300" },
        ],
      },
    ],
    machines: [
      {
        id: "buy",
        scope: "portfolio",
        initial: "watch",
        states: [
          {
            id: "watch",
            transitions: [
              {
                when: "cheap",
                fires: "on_edge",
                to: "watch",
                actions: [
                  { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const envelope: Envelope = {
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
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      slippage_bps: 50,
    },
  };
  const rendered = review(plan, envelope);
  const id = randomUUID();
  const account = signer.address.toLowerCase();
  const expiresAt = new Date(Date.now() + 1800000);
  const name = "Job fixture";
  const artifactId = digest({
    id,
    user: user.id,
    account,
    name,
    mode,
    plan,
    envelope,
    render: rendered.render_text,
    expires: expiresAt.toISOString(),
  });
  const confirmMessage = `Mandate strategy authorization\nOrigin: ${origin}\nChain: 8453\nAccount: ${account}\nArtifact: ${artifactId}\nName: ${name}\nRequested mode: ${mode}\nSign before: ${expiresAt.toISOString()}\n\n${rendered.render_text}`;
  await repo.saveDraft({
    id,
    userId: user.id,
    account,
    artifactId,
    name,
    mode,
    plan,
    envelope,
    renderText: rendered.render_text,
    renderHash: rendered.render_sha256,
    confirmMessage,
    reading: "Fixture",
    createdAt: new Date(),
    expiresAt,
  });
  const draft = required(await repo.draft(user.id, artifactId));
  const instance = await repo.createInstance(
    user.id,
    draft,
    await signer.signMessage({ message: confirmMessage }),
    name,
    1000,
    new Date(),
  );
  // Arming before the mode switch mirrors the API's auto path without an onchain grant.
  await repo.transition(user.id, instance.id, "arm", new Date(), "NG");
  if (mode === "auto")
    await tenant(db, user.id, (tx) =>
      tx.update(schema.instances).set({ mode: "auto" }).where(eq(schema.instances.id, instance.id)),
    );
  clock = new Date();
  return { userId: user.id, instanceId: instance.id };
}

async function orders(userId: string, instanceId: string) {
  return tenant(db, userId, (tx) =>
    tx
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.instanceId, instanceId))
      .orderBy(asc(schema.executions.createdAt)),
  );
}
async function evaluations(userId: string, instanceId: string) {
  return tenant(db, userId, (tx) =>
    tx.select().from(schema.evaluations).where(eq(schema.evaluations.instanceId, instanceId)),
  );
}
async function reload(order: ExecutionRow) {
  return required((await orders(order.userId, order.instanceId)).find((r) => r.id === order.id));
}
/** Builds an admitted order the way the current worker does, bypassing the job gates. */
async function admit(chain: FakeChain = new FakeChain()) {
  const { userId, instanceId } = await fixture("auto");
  const context = await store.context(userId, instanceId);
  await new Admission(store, chain, origin, true, ["NG"]).run(context.instance, context.draft);
  const [order] = await orders(userId, instanceId);
  return required(order);
}

test("a duplicate evaluate-instance commits one evaluation and one intent", async () => {
  const chain = new FakeChain();
  const jobs = deps(chain);
  const { userId, instanceId } = await fixture();
  const first = await dispatch(jobs, {
    name: "evaluate-instance",
    payload: { userId, instanceId },
  });
  expect(first.outcome).toBe("applied");
  expect(first.code).toBe("evaluated");
  expect(first.detail.admitted).toBe(1);

  // The same delivery again, at the same instant: the durable next tick has moved past it.
  const second = await dispatch(jobs, {
    name: "evaluate-instance",
    payload: { userId, instanceId },
  });
  expect(second.outcome).toBe("skipped");
  expect(second.code).toBe("not-due");
  expect(required(second.retryAfterMs)).toBeGreaterThan(0);
  expect(await evaluations(userId, instanceId)).toHaveLength(1);
  const rows = await orders(userId, instanceId);
  expect(rows).toHaveLength(1);
  expect(required(rows[0]).status).toBe("signal");
  expect(required(rows[0]).amountIn).toBe("10000000"); // 10 USDC at 6 decimals, as a string.
  // The refused duplicate never reached the chain.
  expect(chain.snapshots).toBe(1);
});

test("a paused instance is skipped before any observation", async () => {
  const chain = new FakeChain();
  const { userId, instanceId } = await fixture();
  await repo.transition(userId, instanceId, "pause", new Date());
  const result = await evaluate(chain, userId, instanceId);
  expect(result.outcome).toBe("skipped");
  expect(result.code).toBe("instance-not-armed");
  expect(result.detail.status).toBe("paused");
  expect(chain.snapshots).toBe(0);
  expect(chain.authorizations).toBe(0);
  expect(await evaluations(userId, instanceId)).toHaveLength(0);
});

async function evaluate(chain: FakeChain, userId: string, instanceId: string, execute = true) {
  return dispatch(deps(chain, { executeEnabled: execute }), {
    name: "evaluate-instance",
    payload: { userId, instanceId },
  });
}

test("an outstanding order blocks a new automatic admission instead of reserving budget", async () => {
  const chain = new FakeChain();
  await admit(chain); // Another owner's order is now outstanding.
  const { userId, instanceId } = await fixture("auto");
  const result = await evaluate(chain, userId, instanceId);
  expect(result.outcome).toBe("blocked");
  expect(result.code).toBe("signer-busy");
  expect(result.detail.blockingOwned).toBe(false);
  expect(await evaluations(userId, instanceId)).toHaveLength(0);
  expect(await orders(userId, instanceId)).toHaveLength(0);
  // Budget counters are untouched, so the refused tick costs the user nothing.
  const context = await store.context(userId, instanceId);
  expect(context.instance.runtime.totalOrders).toBe(0);
  expect(context.instance.runtime.lifetime).toBe("0");
});

test("a manual signal is never funded", async () => {
  const chain = new FakeChain();
  const { userId, instanceId } = await fixture();
  await evaluate(chain, userId, instanceId);
  const order = required((await orders(userId, instanceId))[0]);
  expect(order.status).toBe("signal");
  const result = await dispatch(deps(chain), {
    name: "execute-intent",
    payload: { userId, executionId: order.id },
  });
  expect(result.outcome).toBe("skipped");
  expect(result.code).toBe("manual-signal-order");
  expect(chain.prepared).toHaveLength(0);
  expect((await reload(order)).status).toBe("signal");
});

test("disabled execution blocks the order instead of cancelling it and burning the budget", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  const result = await dispatch(deps(chain, { executeEnabled: false }), {
    name: "execute-intent",
    payload: { userId: order.userId, executionId: order.id },
  });
  expect(result.outcome).toBe("blocked");
  expect(result.code).toBe("execution-disabled");
  expect(result.retryAfterMs).toBeNull();
  expect(chain.prepared).toHaveLength(0);
  expect((await reload(order)).status).toBe("admitted");

  // What the gate prevents: Lifecycle alone turns a disabled signer into a permanent
  // cancellation, and admission's reservation is never credited back.
  chain.failPrepare = "fund";
  await new Lifecycle(store, chain, 60000).run(await reload(order));
  expect((await reload(order)).status).toBe("cancelled");
  const context = await store.context(order.userId, order.instanceId);
  expect(context.instance.runtime.lifetime).toBe("10");
});

test("a repeated execute-intent journals one leg and rebroadcasts identical bytes", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  const jobs = deps(chain);
  const run = () =>
    dispatch(jobs, {
      name: "execute-intent",
      payload: { userId: order.userId, executionId: order.id },
    });

  const first = await run();
  expect(first.outcome).toBe("applied");
  expect(first.code).toBe("leg-signed");
  expect(first.detail.signedLeg).toBe("fund");
  expect(chain.sent).toHaveLength(0); // Journal commits before anything is broadcast.

  const second = await run();
  expect(second.outcome).toBe("blocked");
  expect(second.code).toBe("awaiting-receipt");
  const third = await run();
  expect(third.code).toBe("awaiting-receipt");
  // One signed leg, one prepared transaction, byte-identical resends.
  expect(await store.journal(order.userId, order.id)).toHaveLength(1);
  expect(chain.prepared).toEqual(["fund"]);
  expect(chain.sent).toEqual([RAW, RAW]);

  // A settled receipt advances exactly one leg per dispatch.
  const [fund] = await store.journal(order.userId, order.id);
  chain.results.set(required(fund).hash, "confirmed");
  const settled = await run();
  expect(settled.outcome).toBe("applied");
  expect(settled.code).toBe("leg-settled");
  expect(settled.detail.legs).toBe("fund:confirmed");
  const next = await run();
  expect(next.detail.signedLeg).toBe("approve");
  expect(chain.prepared).toEqual(["fund", "approve"]);
});

test("job logging never carries signed bytes or a wallet signature", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  const log = recorder();
  const jobs = deps(chain, { log });
  const payload = { userId: order.userId, executionId: order.id };
  await dispatch(jobs, { name: "execute-intent", payload });
  await dispatch(jobs, { name: "execute-intent", payload });
  const { instance } = await store.context(order.userId, order.instanceId);
  expect(log.lines.length).toBeGreaterThan(0);
  const text = JSON.stringify(log.lines);
  expect(text).not.toContain(RAW);
  expect(text).not.toContain(instance.signature);
  // Journal metadata that IS safe to publish still reaches the operator.
  expect(text).toContain("fund");
});

test("log level separates a standing block from ordinary polling", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  const payload = { userId: order.userId, executionId: order.id };

  // Nothing but a configuration change clears this, so it must be visible.
  const standing = recorder();
  await dispatch(deps(chain, { log: standing, executeEnabled: false }), {
    name: "execute-intent",
    payload,
  });
  expect(standing.lines.map((l) => l.level)).toEqual(["warn"]);

  // A journaled leg and the receipt wait that follows are the normal steady state at a 2 s
  // poll: informational, never a warning.
  const waiting = recorder();
  const jobs = deps(chain, { log: waiting });
  await dispatch(jobs, { name: "execute-intent", payload });
  await dispatch(jobs, { name: "execute-intent", payload });
  expect(waiting.lines.map((l) => l.level)).toEqual(["info", "info"]);

  // A re-dispatched instance that is simply not due yet stays out of the operator's way.
  const routine = recorder();
  const { userId, instanceId } = await fixture();
  await dispatch(deps(chain, { log: routine }), {
    name: "evaluate-instance",
    payload: { userId, instanceId },
  });
  await dispatch(deps(chain, { log: routine }), {
    name: "evaluate-instance",
    payload: { userId, instanceId },
  });
  expect(routine.lines.map((l) => l.level)).toEqual(["info", "debug"]);
});

test("an order awaiting operator recovery is inert", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  await tenant(db, order.userId, (tx) =>
    tx
      .update(schema.executions)
      .set({ status: "recovery_required", reason: "Unresolved transaction evidence" })
      .where(eq(schema.executions.id, order.id)),
  );
  const result = await dispatch(deps(chain), {
    name: "execute-intent",
    payload: { userId: order.userId, executionId: order.id },
  });
  expect(result.outcome).toBe("blocked");
  expect(result.code).toBe("recovery-required");
  expect(result.retryAfterMs).toBeNull(); // No timer resolves this; a person does.
  expect(chain.prepared).toHaveLength(0);
  expect(await store.journal(order.userId, order.id)).toHaveLength(0);
});

test("a settled order is skipped rather than replayed", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  await tenant(db, order.userId, (tx) =>
    tx
      .update(schema.executions)
      .set({ status: "confirmed", stage: "done" })
      .where(eq(schema.executions.id, order.id)),
  );
  const result = await dispatch(deps(chain), {
    name: "execute-intent",
    payload: { userId: order.userId, executionId: order.id },
  });
  expect(result.outcome).toBe("skipped");
  expect(result.code).toBe("order-settled");
  expect(chain.prepared).toHaveLength(0);
});

test("another owner's in-flight order holds the signer instead of forcing recovery", async () => {
  const first = new FakeChain();
  const held = await admit(first);
  await dispatch(deps(first), {
    name: "execute-intent",
    payload: { userId: held.userId, executionId: held.id },
  });
  expect((await reload(held)).status).toBe("pending");

  const second = new FakeChain();
  const waiting = await admit(second);
  const result = await dispatch(deps(second), {
    name: "execute-intent",
    payload: { userId: waiting.userId, executionId: waiting.id },
  });
  expect(result.outcome).toBe("blocked");
  expect(result.code).toBe("signer-busy");
  expect(result.detail.blockingStatus).toBe("pending");
  // Untouched: no signing attempt, so no RecoveryRequired from the nonce check and no halt.
  expect(second.prepared).toHaveLength(0);
  expect((await reload(waiting)).status).toBe("admitted");
  expect((await store.context(waiting.userId, waiting.instanceId)).instance.status).toBe("armed");
});

test("an unknown order or instance is skipped, not failed", async () => {
  const chain = new FakeChain();
  const { userId } = await fixture();
  const missing = randomUUID();
  const evaluated = await evaluate(chain, userId, missing);
  expect(evaluated.outcome).toBe("skipped");
  expect(evaluated.code).toBe("instance-unavailable");
  const executed = await dispatch(deps(chain), {
    name: "execute-intent",
    payload: { userId, executionId: missing },
  });
  expect(executed.outcome).toBe("skipped");
  expect(executed.code).toBe("order-unavailable");
});

test("an order belonging to another owner is invisible", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  const other = await fixture();
  const result = await dispatch(deps(chain), {
    name: "execute-intent",
    payload: { userId: other.userId, executionId: order.id },
  });
  expect(result.outcome).toBe("skipped");
  expect(result.code).toBe("order-unavailable");
  expect((await reload(order)).status).toBe("admitted");
});

test("lost leadership escapes both handlers instead of being retried", async () => {
  const chain = new FakeChain();
  const fenced = new WorkerStore(db, {
    assert: async () => {
      throw new LeadershipLost();
    },
  });
  const { userId, instanceId } = await fixture();
  const fencedDeps = deps(chain, {
    store: fenced,
    admission: new Admission(fenced, chain, origin, true, ["NG"]),
    lifecycle: new Lifecycle(fenced, chain, 60000),
  });
  await expect(
    dispatch(fencedDeps, { name: "evaluate-instance", payload: { userId, instanceId } }),
  ).rejects.toBeInstanceOf(LeadershipLost);
  expect(await evaluations(userId, instanceId)).toHaveLength(0);

  const order = await admit(chain);
  await expect(
    dispatch(fencedDeps, {
      name: "execute-intent",
      payload: { userId: order.userId, executionId: order.id },
    }),
  ).rejects.toBeInstanceOf(LeadershipLost);
  // Nothing signed reached the database, so nothing can ever be broadcast for this leg.
  expect(await store.journal(order.userId, order.id)).toHaveLength(0);
  expect(chain.sent).toHaveLength(0);
});

test("an unexpected failure is reported without leaking the upstream message", async () => {
  const chain = new FakeChain();
  const order = await admit(chain);
  const secret = `credential ${RAW}`;
  const result = await dispatch(
    deps(chain, {
      lifecycle: {
        run: async () => {
          throw new Error(secret);
        },
      },
    }),
    { name: "execute-intent", payload: { userId: order.userId, executionId: order.id } },
  );
  expect(result.outcome).toBe("failed");
  expect(result.code).toBe("unexpected-error");
  expect(result.detail.errorName).toBe("Error");
  expect(JSON.stringify(result)).not.toContain(RAW);
  expect(required(result.retryAfterMs)).toBeGreaterThan(0);
});

test("dispatch rejects a malformed job at the queue boundary", async () => {
  const chain = new FakeChain();
  const jobs = deps(chain);
  const { userId, instanceId } = await fixture();
  await expect(
    dispatch(jobs, { name: "evaluate-instance", payload: { userId } }),
  ).rejects.toThrow();
  await expect(
    dispatch(jobs, { name: "evaluate-instance", payload: { userId: "not-a-uuid", instanceId } }),
  ).rejects.toThrow();
  await expect(dispatch(jobs, { name: "settle-everything", payload: {} })).rejects.toThrow();
  await expect(dispatch(jobs, "evaluate-instance")).rejects.toThrow();
  expect(await evaluations(userId, instanceId)).toHaveLength(0);
});

test("createWorkerJobs wires configuration through to a dispatched job", async () => {
  const chain = new FakeChain();
  const config = loadWorkerConfig({
    DATABASE_URL: "postgresql://localhost/mandate",
    APP_ORIGIN: origin,
    WORKER_EXECUTE: "1",
    WORKER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    SPENDER_ADDRESS: `0x${"22".repeat(20)}`,
    ELIGIBLE_COUNTRIES: "NG",
  });
  const jobs = createWorkerJobs(config, store, chain, recorder(), () => clock);
  expect(jobs.executeEnabled).toBe(true);
  const { userId, instanceId } = await fixture("auto");
  const result: JobResult = await jobs.dispatch({
    name: "evaluate-instance",
    payload: { userId, instanceId },
  });
  expect(result.outcome).toBe("applied");
  expect(result.detail.admitted).toBe(1);
  const [order] = await orders(userId, instanceId);
  // Configuration reached Admission: automatic mode plus an eligible country admits.
  expect(required(order).status).toBe("admitted");
  expect(chain.authorizations).toBe(1);
});
