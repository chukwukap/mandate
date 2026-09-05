import type { WorkerConfig } from "@mandate/config";
import type { WorkerLease, WorkerStore } from "@mandate/database";
import { Admission, Lifecycle } from "@mandate/execution";
import type { WorkerChain } from "./chain.js";

export class Worker {
  private readonly admission;
  private readonly lifecycle;
  constructor(
    private readonly config: WorkerConfig,
    private readonly store: WorkerStore,
    private readonly lease: WorkerLease,
    private readonly chain: WorkerChain,
  ) {
    this.admission = new Admission(
      store,
      chain,
      config.origin,
      config.execute,
      config.eligibleCountries,
    );
    this.lifecycle = new Lifecycle(store, chain, config.receiptTimeoutMs);
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
      for (const { instance, draft } of await this.store.due(user, remaining)) {
        if (signal.aborted) return;
        await this.admission.run(instance, draft);
        if (--remaining === 0 || (await this.store.pending(user, 1)).length) return;
      }
    }
  }
  async ready() {
    await this.store.ready();
    return this.chain.reader.ready();
  }
}
