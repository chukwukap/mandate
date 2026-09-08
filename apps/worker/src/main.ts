import { setTimeout as delay } from "node:timers/promises";
import { loadWorkerConfig } from "@mandate/config";
import { connectDatabase, databaseReady, WorkerLease, WorkerStore } from "@mandate/database";
import { loggerOptions } from "@mandate/observability";
import pino from "pino";
import { WorkerChain } from "./chain.js";
import { Worker } from "./worker.js";

async function main() {
  const config = loadWorkerConfig();
  const log = pino(loggerOptions(config.logLevel));
  const database = connectDatabase(config.databaseUrl);
  database.pool.on("error", () => log.error("Database pool connection failed"));
  const lease = new WorkerLease(database.pool, database.db);
  const stop = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const)
    process.once(name, () => {
      stop.abort();
      setTimeout(() => process.exit(1), 30000).unref();
    });
  let heartbeat: NodeJS.Timeout | undefined;
  let beating = false;
  let worker: Worker | undefined;
  try {
    if (!(await databaseReady(database.db))) throw new Error("Database readiness failed");
    const chain = new WorkerChain(config);
    worker = new Worker(config, new WorkerStore(database.db, lease), lease, chain, {
      log,
      // Recovery pages owners with its own cursor, so it needs the handle rather than the
      // shared WorkerStore.
      db: database.db,
      // The pool doubles as the claim connector: `pg.Pool` satisfies ClaimConnector
      // structurally, so the scheduler takes its own dedicated session from it for the
      // per-instance advisory locks and nothing else changes about how the pool is used.
      connector: database.pool,
    });
    // Retried, not fatal on the first miss.
    //
    // `worker.ready()` ends with an RPC round trip, and a public Base endpoint under load
    // answers it in more than the 10s budget often enough to matter — the worker was exiting at
    // boot on a check that succeeded a second later, on config that was entirely valid.
    // Leadership already waits in a loop for the same class of reason; readiness deserves the
    // same patience. Bounded, so a genuinely misconfigured worker still stops rather than
    // retrying forever.
    let ready = false;
    for (let attempt = 1; attempt <= 5 && !stop.signal.aborted && !ready; attempt += 1) {
      // The reason travels with the retry. `Scheduler.ready()` reports clock skew by THROWING a
      // Problem carrying the measured numbers and the remedy, so a bare `catch(() => false)`
      // turns a precise diagnosis into "not ready" and sends an operator to check their RPC.
      let reason: string | undefined;
      ready = await worker.ready().catch((error: unknown) => {
        reason = error instanceof Error ? error.message : String(error);
        return false;
      });
      if (ready) break;
      log.warn({ attempt, ...(reason ? { reason } : {}) }, "Worker not ready yet; retrying");
      await delay(3_000, undefined, { signal: stop.signal }).catch(() => {});
    }
    if (!ready && !stop.signal.aborted) throw new Error("Worker readiness failed");
    while (!stop.signal.aborted && !(await lease.acquire())) {
      log.info("Another worker holds leadership; waiting");
      await delay(config.pollMs, undefined, { signal: stop.signal }).catch(() => {});
    }
    if (!stop.signal.aborted) {
      // Keep long read-only RPC work alive; heartbeat never overlaps itself.
      heartbeat = setInterval(async () => {
        if (beating) return;
        beating = true;
        try {
          await lease.heartbeat();
        } catch {
          log.error("Worker leadership lost");
          stop.abort();
          process.exitCode = 1;
        } finally {
          beating = false;
        }
      }, 10000);
      log.info({ executionEnabled: config.execute }, "Worker started");
      while (!stop.signal.aborted) {
        try {
          await worker.cycle(stop.signal);
        } catch (error) {
          // Named, not swallowed. A bare catch here logs "cycle failed" on every pass and leaves
          // an operator with a loop that is plainly broken and no way to tell why — which is
          // exactly the position this was in.
          log.error(
            { reason: error instanceof Error ? error.message : String(error) },
            "Worker cycle failed; durable state retained for retry",
          );
          // Mark the lease unhealthy so /ready reports execution as unavailable while the loop
          // is failing, and give up leadership if even that write cannot land.
          await lease.heartbeat(false).catch(() => {
            stop.abort();
            process.exitCode = 1;
          });
        }
        await delay(config.pollMs, undefined, { signal: stop.signal }).catch(() => {});
      }
    }
  } catch {
    log.error("Worker startup failed; check configuration, migrations and RPC availability");
    process.exitCode = 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Before the pool closes: the scheduler holds a checked-out session for its advisory locks,
    // and closing the pool under it would surface as a connection error on the way out.
    await worker?.close().catch(() => {});
    await lease.close().catch(() => {});
    await database.close();
    log.info("Worker stopped");
  }
}
main().catch(() => {
  console.error("Worker failed; check configuration and dependencies.");
  process.exitCode = 1;
});
