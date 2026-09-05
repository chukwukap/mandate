/** Dependency probes the readiness answer is derived from. All three may reject or hang. */
export interface ReadinessDependencies {
  /** Reachable, migrated, and NOT running as a superuser/BYPASSRLS role. */
  databaseReady(): Promise<boolean>;
  /** Base RPC answers and reports chain id 8453. */
  chainReady(): Promise<boolean>;
  /** A live execution-enabled worker heartbeat. Absent when no worker is deployed. */
  workerAvailable?(): Promise<boolean>;
}

export interface ReadinessReport {
  /** Serve traffic? Database AND chain. Deliberately excludes `execution`. */
  ready: boolean;
  database: boolean;
  chain: boolean;
  /** Worker heartbeat. Reported, never a reason to fail readiness. */
  execution: boolean;
}

export interface ReadinessOptions {
  /** Per-check deadline. A check that has not answered by then counts as false. */
  readonly timeoutMs?: number;
  /** How long a completed verdict is reused. 0 disables reuse. */
  readonly cacheMs?: number;
  /** Injectable clock so the cache window is testable without sleeping. */
  readonly now?: () => number;
}

/**
 * 4s. The real budget is the orchestrator's probe timeout (commonly 1–5s): once we exceed it,
 * a slow answer and no answer are the same verdict to the load balancer, except that hanging
 * also pins a connection and a pool slot on an instance that is already struggling.
 *
 * This is deliberately shorter than what the underlying clients can take on their own —
 * BaseReader's HTTP transport uses a 5s timeout with one retry, so a wedged RPC can occupy
 * ~11s — which means we will call chain false while a very slow RPC is still technically
 * working. That is the intended trade: if `getBlockNumber` needs more than four seconds, the
 * quote path this instance exists to serve is already unusable, and reporting unready sheds
 * traffic to a replica with a healthier upstream.
 */
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * 1s. Bounds the cost of probe traffic without hiding an outage for meaningfully longer than
 * one probe interval. `chainReady()` is not free: BaseReader.ready() resets its network cache
 * and issues getChainId + getBlockNumber against a rate-limited public RPC on every call. N
 * replicas polled once a second would otherwise spend the RPC budget the quote path needs on
 * telling a load balancer something it already knows.
 */
const DEFAULT_CACHE_MS = 1_000;

/**
 * Runs one dependency check under a deadline, converting every failure mode to `false`.
 *
 * Three failure modes, one answer: rejection (the dependency said no), synchronous throw (a
 * misconfigured dependency), and silence (pool exhaustion, a TCP connection to a host that is
 * dropping packets). The last is the one a bare `.catch(() => false)` does not cover, and it is
 * the common one during a real incident.
 *
 * The timer is cleared on the winning path. A stray 4s timer keeps the event loop alive past
 * `app.close()` and presents as a hanging `bun test` run; `unref` is a second line of defence
 * for the case where the process wants to exit while a probe is still in flight.
 */
function bounded(run: (() => Promise<boolean>) | undefined, timeoutMs: number): Promise<boolean> {
  if (!run) return Promise.resolve(false);
  const attempt = Promise.resolve()
    .then(run)
    .then(
      (value) => value === true,
      () => false,
    );
  if (timeoutMs <= 0) return attempt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([attempt, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Builds the readiness prober used by `GET /ready`.
 *
 * Two behaviours beyond running the checks, both of which exist because a readiness endpoint is
 * hit by every replica of every load balancer, forever:
 *
 *  - single flight: concurrent probes share one in-flight run, so a burst of health checks
 *    arriving while the database is slow does not multiply into a burst of database work. This
 *    mirrors the coalescing BaseReader already uses for `market()`.
 *  - short TTL cache: see DEFAULT_CACHE_MS.
 *
 * The returned function never rejects. A readiness endpoint that can 500 is worse than useless:
 * the orchestrator reads any non-2xx as unready, so the only thing a thrown error adds is a
 * misleading `internal-error` in the logs during an outage that is not internal.
 */
export function createReadinessProbe(
  deps: ReadinessDependencies,
  options: ReadinessOptions = {},
): () => Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; report: ReadinessReport } | undefined;
  let pending: Promise<ReadinessReport> | undefined;

  const probe = async (): Promise<ReadinessReport> => {
    // `workerAvailable` reads the worker_state row, so it fails whenever the database does. It
    // must degrade to false rather than escalate: letting that rejection out would turn an
    // honest 503 "database down" into a 500 "internal error" and lose the diagnosis.
    const worker = deps.workerAvailable;
    const [database, chain, execution] = await Promise.all([
      bounded(() => deps.databaseReady(), timeoutMs),
      bounded(() => deps.chainReady(), timeoutMs),
      bounded(worker ? () => worker.call(deps) : undefined, timeoutMs),
    ]);
    return { ready: database && chain, database, chain, execution };
  };

  return async function readiness(): Promise<ReadinessReport> {
    if (cached && now() - cached.at < cacheMs) return { ...cached.report };
    if (pending) return { ...(await pending) };
    pending = probe();
    try {
      const report = await pending;
      // Stamped after completion, so a slow probe's answer is fresh for its full TTL rather
      // than being expired the moment it is produced.
      cached = { at: now(), report };
      return { ...report };
    } finally {
      pending = undefined;
    }
  };
}
