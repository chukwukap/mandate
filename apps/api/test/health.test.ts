import { afterEach, expect, test } from "bun:test";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createReadinessProbe,
  type HealthDependencies,
  registerHealth,
} from "../src/modules/health/index.js";

const opened: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function serve(deps: HealthDependencies, options?: Parameters<typeof registerHealth>[2]) {
  const app = Fastify({ logger: false });
  await registerHealth(app, deps, options ?? {});
  opened.push(app);
  await app.ready();
  return app;
}

const healthy: HealthDependencies = {
  databaseReady: async () => true,
  chainReady: async () => true,
};

test("liveness answers while every dependency is failing", async () => {
  // The point of separating /health from /ready: a database outage must not make the
  // orchestrator kill every replica at once.
  const app = await serve({
    databaseReady: async () => {
      throw new Error("connection refused");
    },
    chainReady: async () => {
      throw new Error("rpc down");
    },
    workerAvailable: async () => {
      throw new Error("no worker");
    },
  });
  const response = await app.inject({ url: "/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json<Record<string, unknown>>()).toEqual({ status: "ok" });
});

test("liveness consults no dependency at all", async () => {
  let calls = 0;
  const count = async () => {
    calls += 1;
    return true;
  };
  const app = await serve({ databaseReady: count, chainReady: count, workerAvailable: count });
  expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  expect(calls).toBe(0);
});

test("readiness reports ready with the exact documented body", async () => {
  const app = await serve({ ...healthy, workerAvailable: async () => true });
  const response = await app.inject({ url: "/ready" });
  expect(response.statusCode).toBe(200);
  expect(response.json<Record<string, unknown>>()).toEqual({
    status: "ready",
    database: true,
    chain: true,
    execution_available: true,
  });
});

test("a rejecting database yields 503 and leaks nothing about the failure", async () => {
  const app = await serve({
    databaseReady: async () => {
      throw new Error("postgres://user:hunter2@db.internal/mandate");
    },
    chainReady: async () => true,
  });
  const response = await app.inject({ url: "/ready" });
  expect(response.statusCode).toBe(503);
  expect(response.json<Record<string, unknown>>()).toEqual({
    status: "unavailable",
    database: false,
    chain: true,
    execution_available: false,
  });
  expect(response.body).not.toContain("hunter2");
});

test("a worker heartbeat failure degrades execution_available, it does not 500", async () => {
  // workerAvailable() is itself a SELECT: when Postgres is down it rejects. Letting that
  // escape would replace an honest 503 with an internal-error 500.
  const app = await serve({
    ...healthy,
    workerAvailable: async () => {
      throw new Error("worker_state unreadable");
    },
  });
  const response = await app.inject({ url: "/ready" });
  expect(response.statusCode).toBe(200);
  expect(response.json().execution_available).toBe(false);
});

test("a synchronously throwing dependency is a false, not a crash", async () => {
  const probe = createReadinessProbe(
    {
      databaseReady: (() => {
        throw new Error("misconfigured");
      }) as HealthDependencies["databaseReady"],
      chainReady: async () => true,
    },
    { cacheMs: 0 },
  );
  expect(await probe()).toEqual({ ready: false, database: false, chain: true, execution: false });
});

test("a hung dependency resolves false at the deadline instead of holding the request", async () => {
  const stuck = deferred<boolean>();
  let settled = false;
  const app = await serve(
    {
      databaseReady: () => stuck.promise,
      chainReady: async () => true,
    },
    { readiness: { timeoutMs: 25, cacheMs: 0 } },
  );
  const started = Date.now();
  const response = await app.inject({ url: "/ready" });
  const elapsed = Date.now() - started;
  expect(response.statusCode).toBe(503);
  expect(response.json().database).toBe(false);
  // Far below fastify's 60s requestTimeout, which is what would otherwise bound this.
  expect(elapsed).toBeLessThan(2_000);
  stuck.resolve(true);
  await stuck.promise.then(() => {
    settled = true;
  });
  expect(settled).toBe(true);
});

test("concurrent probes are coalesced into one run of each check", async () => {
  let database = 0;
  let chain = 0;
  const gate = deferred<void>();
  const probe = createReadinessProbe(
    {
      databaseReady: async () => {
        database += 1;
        await gate.promise;
        return true;
      },
      chainReady: async () => {
        chain += 1;
        return true;
      },
    },
    { cacheMs: 0 },
  );
  const all = Promise.all([probe(), probe(), probe(), probe()]);
  gate.resolve();
  const reports = await all;
  expect(database).toBe(1);
  expect(chain).toBe(1);
  for (const report of reports) expect(report.ready).toBe(true);
});

test("a completed verdict is reused for the cache window and then re-probed", async () => {
  let calls = 0;
  let clock = 1_000;
  const probe = createReadinessProbe(
    {
      databaseReady: async () => {
        calls += 1;
        return true;
      },
      chainReady: async () => true,
    },
    { cacheMs: 1_000, now: () => clock },
  );
  await probe();
  await probe();
  expect(calls).toBe(1);
  clock += 999;
  await probe();
  expect(calls).toBe(1);
  clock += 2;
  await probe();
  expect(calls).toBe(2);
});

test("a recovered dependency is reported once the cache window passes", async () => {
  let up = false;
  let clock = 0;
  const probe = createReadinessProbe(
    { databaseReady: async () => up, chainReady: async () => true },
    { cacheMs: 1_000, now: () => clock },
  );
  expect((await probe()).ready).toBe(false);
  up = true;
  clock += 1_001;
  expect((await probe()).ready).toBe(true);
});

test("the caller cannot mutate the cached verdict", async () => {
  const probe = createReadinessProbe(healthy, { cacheMs: 60_000 });
  const first = await probe();
  first.ready = false;
  first.database = false;
  expect((await probe()).ready).toBe(true);
});

test("probe routes are exempt from the global rate limit", async () => {
  // A load balancer polling /ready once a second from a single source IP would otherwise trip
  // the 120/min limit; the orchestrator reads a 429 as unready and restarts a healthy instance.
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 1, timeWindow: "1 minute" });
  await registerHealth(app, healthy);
  app.get("/limited", async () => ({ ok: true }));
  opened.push(app);
  await app.ready();

  for (let i = 0; i < 5; i += 1) {
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ready" })).statusCode).toBe(200);
  }
  expect((await app.inject({ url: "/limited" })).statusCode).toBe(200);
  expect((await app.inject({ url: "/limited" })).statusCode).toBe(429);
});

test("readiness stays available even when a dependency never settles across many probes", async () => {
  const app = await serve(
    { databaseReady: () => new Promise<boolean>(() => {}), chainReady: async () => true },
    { readiness: { timeoutMs: 20, cacheMs: 0 } },
  );
  for (let i = 0; i < 3; i += 1) {
    const response = await app.inject({ url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().database).toBe(false);
  }
});
