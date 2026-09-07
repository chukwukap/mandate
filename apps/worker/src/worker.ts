import type { WorkerConfig } from "@mandate/config";
import type { WorkerLease, WorkerStore } from "@mandate/database";
import { Admission, Lifecycle } from "@mandate/execution";
import type { WorkerChain } from "./chain.js";
import type { JobLogger } from "./jobs/types.js";
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
}

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
  constructor(
    private readonly config: WorkerConfig,
    private readonly store: WorkerStore,
    private readonly lease: WorkerLease,
    private readonly chain: WorkerChain,
    options: WorkerOptions = {},
  ) {
    const { log, connector } = options;
    this.admission = new Admission(
      store,
      chain,
      config.origin,
      config.execute,
      config.eligibleCountries,
      // A strategy that fails to verify reached the database by some path other than the API
      // accepting a signature; it is the one admission failure that says something about the
      // system rather than about the market, so it is the one that is logged.
      (instanceId, error) =>
        log?.error(
          { instanceId, reason: error instanceof Error ? error.message : String(error) },
          "Stored strategy failed commitment verification; refusing to evaluate it",
        ),
    );
    this.lifecycle = new Lifecycle(store, chain, config.receiptTimeoutMs);
    this.scheduler =
      connector && log ? new Scheduler({ store, connector, log }) : undefined;
  }
  async cycle(signal: AbortSignal) {
    const active = await this.store.activeExecution();
    await this.lease.heartbeat(this.config.execute && active?.status !== "recovery_required");
    if (signal.aborted) return;
    // Reconcile every admitted order before any new strategy can reserve funds.
    if (active) {
      if (this.config.execute) await this.lifecycle.run(active);
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
