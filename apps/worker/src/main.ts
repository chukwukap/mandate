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
  try {
    if (!(await databaseReady(database.db))) throw new Error("Database readiness failed");
    const chain = new WorkerChain(config);
    const worker = new Worker(config, new WorkerStore(database.db, lease), lease, chain);
    if (!(await worker.ready())) throw new Error("Worker readiness failed");
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
        } catch {
          log.error("Worker cycle failed; durable state retained for retry");
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
    await lease.close().catch(() => {});
    await database.close();
    log.info("Worker stopped");
  }
}
main().catch(() => {
  console.error("Worker failed; check configuration and dependencies.");
  process.exitCode = 1;
});
