import type { WorkerConfig } from "@mandate/config";
import type { Database, WorkerLease, WorkerStore } from "@mandate/database";
import type { WorkerChain } from "./chain.js";
import { createWorkerJobs } from "./jobs/index.js";
import type { JobLogger } from "./jobs/types.js";
import { Recovery } from "./recovery/index.js";
import { type ClaimConnector, Scheduler } from "./scheduler/index.js";

/**
 * Optional collaborators, as a bag rather than more positional parameters.
 *
 * Both are optional so the loop still runs without them: a worker with no logger and no
 * connector behaves exactly as it did before, evaluating every due instance on the plain
 * cadence. What they add is the scheduling and the reporting, not the trading.
 */
export interface WorkerOptions {
  log?: JobLogger | undefined;
  /**
   * A `pg.Pool`, which satisfies `ClaimConnector` structurally. Supplying it turns on the
   * scheduler: per-instance advisory locks, so two workers cannot evaluate the same strategy
   * in the same second, and failure backoff, so a strategy that cannot succeed stops asking.
   */
  connector?: ClaimConnector | undefined;
  /**
   * The database handle, for the recovery pass.
   *
   * Recovery pages every owner to reconstruct what this worker has committed for a wallet
   * key, and it must do that with its own cursor rather than the shared `WorkerStore.owners()`
   * one that the scheduling loop reads — see `eachOwner`.
   */
  db?: Database | undefined;
}

/**
 * Used when no logger was supplied. `createWorkerJobs` requires one, and a Worker built without
 * a logger should still get the same wiring rather than a second, quieter copy of it.
 */
const SILENT: JobLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class Worker {
  private readonly admission;
  private readonly lifecycle;
  /**
   * Present only when a connector was supplied. `scheduler/` was written to sit exactly here
   * — its own docstring gives this call shape — but nothing ever constructed it, so the whole
   * subsystem was unreachable from `main.ts` and the worker retried a permanently failing
   * instance every 30 seconds forever. Observed: ten identical `invalid-commitment` refusals
   * at a flat 30s spacing before this was wired.
   */
  private readonly scheduler;
  /**
   * Present when execution is on and a database handle was supplied.
   *
   * Without it a `recovery_required` order is permanent: `Lifecycle.run` returns immediately on
   * that status and nothing else moves it, while `cycle` keeps blocking admissions for every
   * owner because the order is still outstanding. One stuck trade halted the whole fleet.
   */
  private readonly recovery;
  constructor(
    private readonly config: WorkerConfig,
    private readonly store: WorkerStore,
    private readonly lease: WorkerLease,
    private readonly chain: WorkerChain,
    options: WorkerOptions = {},
  ) {
    const { log, connector } = options;
    // One place where the execution collaborators are configured.
    //
    // These were built inline here AND in `createWorkerJobs`, identically, which is the
    // duplication that file's own docstring asks to remove: two constructions of Admission with
    // the same five arguments will eventually disagree about one of them, and the one that
    // matters is `config.execute`. Building them there and reading them here means the jobs
    // module is reachable from main.ts as well, rather than being 867 lines that only its own
    // test ever ran.
    const jobs = createWorkerJobs(config, store, chain, log ?? SILENT);
    this.admission = jobs.admission;
    this.lifecycle = jobs.lifecycle;
    this.scheduler = connector && log ? new Scheduler({ store, connector, log }) : undefined;
    this.recovery =
      options.db && log && config.execute
        ? new Recovery({
            store,
            db: options.db,
            chain,
            log,
            receiptTimeoutMs: config.receiptTimeoutMs,
          })
        : undefined;
  }
  async cycle(signal: AbortSignal) {
    // Before anything reads a price: on a demo fork the reference is only as fresh as the last
    // block, and nothing else produces one.
    if (this.config.demo) await this.chain.alignDemoClock();
    const active = await this.store.activeExecution();
    await this.lease.heartbeat(this.config.execute && active?.status !== "recovery_required");
    if (signal.aborted) return;
    // Reconcile every admitted order before any new strategy can reserve funds.
    if (active) {
      if (!this.config.execute) return;
      // A stuck order is the lifecycle's dead end — it returns immediately on this status — so
      // it is recovery's to look at. Still `return` afterwards: the order remains outstanding
      // until a pass clears it, and admitting a new one alongside it is exactly what the
      // single-order gate exists to prevent.
      if (active.status === "recovery_required") {
        if (this.recovery) await this.recovery.run(active);
        return;
      }
      await this.lifecycle.run(active);
      return;
    }
    let remaining = this.config.maxBatch;
    for (const user of await this.store.owners(this.config.maxBatch)) {
      // Instances skipped this cycle because their claim was refused. They keep their
      // `next_tick_at`, and `due` is `order by next_tick_at asc limit n` with no offset, so they
      // stay at the head of every subsequent window. Widening the request by the number already
      // skipped is what stops one unclaimable instance from occupying the whole batch forever
      // and starving every other strategy that owner has.
      let skipped = 0;
      while (remaining > 0) {
        const batch = await this.store.due(user, remaining + skipped);
        if (batch.length <= skipped) break;
        let evaluated = false;
        for (const { instance, draft } of batch.slice(skipped)) {
          if (signal.aborted) return;
          // No claim means another worker holds this instance, or it is gated in process after a
          // failed settle. Skipping does not spend `remaining`: nothing was evaluated, so the
          // batch budget was not used.
          const claim = await this.scheduler?.claim(instance, draft);
          if (this.scheduler && !claim) {
            skipped++;
            continue;
          }
          evaluated = true;
          try {
            await this.admission.run(instance, draft);
          } finally {
            // In `finally` because settle also releases the advisory lock. A throw out of
            // admission that skipped this would hold the lock for the life of the process and
            // freeze that instance on every worker.
            if (claim) await this.scheduler?.settle(claim);
          }
          if (--remaining === 0 || (await this.store.pending(user, 1)).length) return;
        }
        // A pass that claimed nothing new will claim nothing next time either — the refusals are
        // durable for this cycle. Stop rather than widen the window without bound.
        if (!evaluated) break;
      }
    }
  }
  async ready() {
    await this.store.ready();
    // Checked before the chain because a clock skewed against the database makes `next_tick_at`
    // meaningless, and a worker that cannot tell what is due should not start at all.
    if (this.scheduler && !(await this.scheduler.ready())) return false;
    return this.chain.reader.ready();
  }
  /** Releases the claim connection. Safe to call when no scheduler was configured. */
  async close() {
    await this.scheduler?.close();
  }
}
