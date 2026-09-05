import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadWorkerConfig } from "@mandate/config";
import {
  connectDatabase,
  type Database,
  Repository,
  schema,
  tenant,
  WorkerLease,
  WorkerStore,
  workerAvailable,
} from "@mandate/database";
import { ASSETS, USDC } from "@mandate/evm";
import {
  Admission,
  type Executor,
  Lifecycle,
  type Observation,
  type Observations,
} from "@mandate/execution";
import { digest, type Envelope, type Plan, review } from "@mandate/strategy";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executionSession, WorkerChain } from "../src/chain.js";

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture");
  return value;
}

const memory = process.env.TEST_DATABASE_URL ? undefined : new PGlite();
const native = process.env.TEST_DATABASE_URL
  ? connectDatabase(process.env.TEST_DATABASE_URL)
  : undefined;
let db: Database;
let store: WorkerStore;
let repo: Repository;
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const origin = "http://localhost:3000";
const observation: Observations = {
  authorize: async () => {},
  verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
  snapshot: async () => ({
    at: Date.now(),
    feeds: { "oracle:AAPLc": "200", "dex:AAPLc": "200" },
    portfolio: { equity: "100", positions: { [required(ASSETS[0]).token.toLowerCase()]: "0" } },
  }),
};
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
  const name = "Worker fixture";
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
  await repo.transition(user.id, instance.id, "arm", new Date(), "NG");
  if (mode === "auto")
    await tenant(db, user.id, (tx) =>
      tx.update(schema.instances).set({ mode: "auto" }).where(eq(schema.instances.id, instance.id)),
    );
  return store.context(user.id, instance.id);
}
async function orders(user: string, id: string) {
  return tenant(db, user, (tx) =>
    tx.select().from(schema.executions).where(eq(schema.executions.instanceId, id)),
  );
}
async function admit() {
  const context = await fixture("auto");
  await new Admission(store, observation, origin, true, ["NG"]).run(
    context.instance,
    context.draft,
  );
  return required((await store.pending(context.instance.userId, 1))[0]);
}
class FakeExecutor implements Executor {
  prepared: string[] = [];
  sent: string[] = [];
  results = new Map<string, Observation>();
  fail: string | undefined;
  async prepare(leg: Parameters<Executor["prepare"]>[0]) {
    if (leg === this.fail) throw new Error("Simulated unavailable route");
    this.prepared.push(leg);
    const nonce = this.prepared.length;
    return {
      signer: `0x${randomUUID().replaceAll("-", "")}00000000`,
      nonce,
      rawTransaction: "0x1234",
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
async function refresh(order: Awaited<ReturnType<typeof admit>>) {
  return required((await orders(order.userId, order.instanceId)).find((r) => r.id === order.id));
}
async function settle(
  order: Awaited<ReturnType<typeof admit>>,
  chain: FakeExecutor,
  status: Observation = "confirmed",
) {
  const journal = await store.journal(order.userId, order.id);
  const pending = required(journal.find((t) => t.status === "signed"));
  chain.results.set(pending.hash, status);
  await new Lifecycle(store, chain, 60000).run(await refresh(order));
}
test("manual evaluation atomically records a signal and does not repeat an unchanged edge", async () => {
  const context = await fixture();
  const admission = new Admission(store, observation, origin, false, []);
  await admission.run(context.instance, context.draft);
  const rows = await orders(context.instance.userId, context.instance.id);
  expect(rows).toHaveLength(1);
  expect(required(rows[0]).status).toBe("signal");
  await admission.run(context.instance, context.draft); // stale concurrent observation
  expect(await orders(context.instance.userId, context.instance.id)).toHaveLength(1);
  expect(
    (await store.context(context.instance.userId, context.instance.id)).instance.runtime.lifetime,
  ).toBe("10");
});
test("missing observations and disabled automatic execution preserve the unfired runtime", async () => {
  for (const disabled of [true, false]) {
    const c = await fixture("auto");
    await new Admission(
      store,
      {
        ...observation,
        snapshot: async () => {
          throw new Error("Unavailable");
        },
      },
      origin,
      !disabled,
      ["NG"],
    ).run(c.instance, c.draft);
    expect(await orders(c.instance.userId, c.instance.id)).toHaveLength(0);
    expect(
      (await store.context(c.instance.userId, c.instance.id)).instance.runtime.totalOrders,
    ).toBe(0);
  }
});
test("expired eligibility pauses automatic strategy until an eligible arm request", async () => {
  const c = await fixture("auto");
  await new Admission(store, observation, origin, true, []).run(c.instance, c.draft);
  expect((await store.context(c.instance.userId, c.instance.id)).instance.status).toBe("paused");
  expect(await orders(c.instance.userId, c.instance.id)).toHaveLength(0);
});
test("a closed market or inactive authority does not consume an automatic firing", async () => {
  const c = await fixture("auto");
  await new Admission(
    store,
    {
      ...observation,
      authorize: async () => {
        throw new Error("Market paused");
      },
    },
    origin,
    true,
    ["NG"],
  ).run(c.instance, c.draft);
  expect(await orders(c.instance.userId, c.instance.id)).toHaveLength(0);
  expect((await store.context(c.instance.userId, c.instance.id)).instance.runtime.totalOrders).toBe(
    0,
  );
});
test("leadership loss after signing prevents journal commit and broadcast", async () => {
  const order = await admit();
  const chain = new FakeExecutor();
  const fenced = new WorkerStore(db, {
    assert: async () => {
      throw new Error("Leadership lost");
    },
  });
  await expect(new Lifecycle(fenced, chain, 60000).run(order)).rejects.toThrow("Leadership lost");
  expect(await store.journal(order.userId, order.id)).toHaveLength(0);
  expect(chain.sent).toHaveLength(0);
});
test("restart broadcasts persisted bytes and advances funding, approval, swap once", async () => {
  const order = await admit();
  const chain = new FakeExecutor();
  const run = async () => new Lifecycle(store, chain, 60000).run(await refresh(order));
  await run();
  expect(chain.sent).toHaveLength(0);
  expect(chain.prepared).toEqual(["fund"]);
  await run();
  await run();
  expect(chain.sent).toEqual(["0x1234", "0x1234"]);
  expect(chain.prepared).toHaveLength(1);
  await settle(order, chain);
  await run();
  expect(chain.prepared).toEqual(["fund", "approve"]);
  await settle(order, chain);
  await run();
  expect(chain.prepared).toEqual(["fund", "approve", "swap"]);
  await settle(order, chain);
  await run();
  expect((await refresh(order)).status).toBe("confirmed");
  expect((await store.journal(order.userId, order.id)).every((t) => t.status === "confirmed")).toBe(
    true,
  );
});
test("pause after funding clears allowance then refunds; never pulls again", async () => {
  const order = await admit();
  const chain = new FakeExecutor();
  const run = async () => new Lifecycle(store, chain, 60000).run(await refresh(order));
  await run();
  await settle(order, chain);
  await repo.transition(order.userId, order.instanceId, "pause", new Date());
  await run();
  expect(chain.prepared).toEqual(["fund", "reset"]);
  await settle(order, chain);
  await run();
  expect(chain.prepared.at(-1)).toBe("refund");
  await settle(order, chain);
  await run();
  expect((await refresh(order)).status).toBe("refunded");
});
test("failed funding is terminal, and unknown receipt evidence halts for recovery", async () => {
  for (const result of ["reverted", "ambiguous"] as const) {
    const order = await admit();
    const chain = new FakeExecutor();
    const lifecycle = new Lifecycle(store, chain, 60000);
    await lifecycle.run(order);
    await settle(order, chain, result);
    await lifecycle.run(await refresh(order));
    expect((await refresh(order)).status).toBe(
      result === "reverted" ? "reverted" : "recovery_required",
    );
    expect(chain.prepared).toEqual(["fund"]);
  }
});
test("a changed settled receipt blocks the next leg", async () => {
  const order = await admit();
  const chain = new FakeExecutor();
  const lifecycle = new Lifecycle(store, chain, 60000);
  await lifecycle.run(order);
  await settle(order, chain);
  const [fund] = await store.journal(order.userId, order.id);
  chain.results.set(required(fund).hash, "pending");
  await lifecycle.run(await refresh(order));
  expect((await refresh(order)).status).toBe("recovery_required");
  expect(chain.prepared).toEqual(["fund"]);
});
test("unavailable funded swap goes through allowance reset and refund", async () => {
  const order = await admit();
  const chain = new FakeExecutor();
  const run = async () => new Lifecycle(store, chain, 60000).run(await refresh(order));
  await run();
  await settle(order, chain);
  await run();
  await settle(order, chain);
  chain.fail = "swap";
  await run();
  expect((await refresh(order)).stage).toBe("reset");
  await run();
  await settle(order, chain);
  await run();
  await settle(order, chain);
  await run();
  expect(chain.prepared).toEqual(["fund", "approve", "reset", "refund"]);
  expect((await refresh(order)).status).toBe("refunded");
});
test("a kill before funding cancels the intent without signing", async () => {
  const order = await admit();
  const chain = new FakeExecutor();
  await repo.transition(order.userId, order.instanceId, "kill", new Date());
  await new Lifecycle(store, chain, 60000).run(order);
  expect((await refresh(order)).status).toBe("cancelled");
  expect(chain.prepared).toHaveLength(0);
});
test("signed journal is immutable and isolated from other owners", async () => {
  const order = await admit();
  await new Lifecycle(store, new FakeExecutor(), 60000).run(order);
  const [tx] = await store.journal(order.userId, order.id);
  await expect(
    tenant(db, order.userId, (t) =>
      t
        .update(schema.transactions)
        .set({ rawTransaction: "0xffff" })
        .where(eq(schema.transactions.id, required(tx).id)),
    ),
  ).rejects.toThrow();
  const other = await fixture();
  expect(await store.journal(other.instance.userId, order.id)).toHaveLength(0);
});
test("configuration separates server identity credentials from worker signing authority", () => {
  const base = { DATABASE_URL: "postgresql://localhost/mandate" };
  expect(loadWorkerConfig(base).execute).toBe(false);
  expect(() => loadWorkerConfig({ ...base, WORKER_EXECUTE: "1" })).toThrow();
  expect(() => loadWorkerConfig({ ...base, ELIGIBLE_COUNTRIES: "US" })).toThrow();
  expect(
    () =>
      new WorkerChain(
        loadWorkerConfig({
          ...base,
          WORKER_EXECUTE: "1",
          WORKER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
          SPENDER_ADDRESS: `0x${"22".repeat(20)}`,
        }),
      ),
  ).toThrow("does not match");
});
test("session follows New York daylight saving time and refuses weekends", () => {
  expect(executionSession(new Date("2026-09-04T14:00:00Z"))).toBe(true);
  expect(executionSession(new Date("2026-09-05T14:00:00Z"))).toBe(false);
  expect(executionSession(new Date("2026-01-05T14:00:00Z"))).toBe(false);
  expect(executionSession(new Date("2026-01-05T15:00:00Z"))).toBe(true);
});
test.skipIf(!native)(
  "native PostgreSQL elects one leader and fences a superseded generation",
  async () => {
    const first = new WorkerLease(required(native).pool, db);
    const second = new WorkerLease(required(native).pool, db);
    try {
      expect(await first.acquire()).toBe(true);
      expect(await second.acquire()).toBe(false);
      await first.heartbeat(true);
      expect(await workerAvailable(db)).toBe(true);
      const c = await fixture();
      await tenant(db, c.instance.userId, (tx) => first.assert(tx));
      await first.close();
      expect(await workerAvailable(db)).toBe(false);
      expect(await second.acquire()).toBe(true);
      await expect(tenant(db, c.instance.userId, (tx) => first.assert(tx))).rejects.toThrow();
    } finally {
      await first.close();
      await second.close();
    }
  },
);
