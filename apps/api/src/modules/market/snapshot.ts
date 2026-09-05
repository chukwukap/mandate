import {
  type Asset,
  type ChainReader,
  type MarketFeed,
  Problem,
  type Quote,
} from "@mandate/contracts";
import {
  type CatalogueEntry,
  catalogueEntry,
  DEVIATION_LIMIT_BPS,
  PROBE_NOTIONAL_USDC,
  PROBE_SLIPPAGE_BPS,
  type ProbeSpec,
  SNAPSHOT_TTL_MS,
} from "./catalogue.js";

/**
 * A cold refresh reads the oracle and probes the quoter once per asset. Against a slow public
 * RPC that could otherwise creep toward Fastify's 60s requestTimeout while holding the single
 * in-flight refresh, so the whole refresh is bounded and unfinished assets are reported as
 * chain-unavailable rather than left hanging.
 */
export const SNAPSHOT_DEADLINE_MS = 10_000;

export type ProbeTerms = {
  side: "buy" | "sell";
  amount: string;
  slippage_bps: number;
  deviation_limit_bps: number;
  note: string;
};

export type MarketSnapshot = {
  as_of: string;
  feeds: MarketFeed[];
  catalogue: CatalogueEntry[];
  probe: ProbeTerms;
};

/** Only pino's shape is needed; the service never sees a Fastify instance. */
export type SnapshotLogger = { warn(details: Record<string, unknown>, message: string): void };

export type SnapshotOptions = {
  ttlMs?: number | undefined;
  deadlineMs?: number | undefined;
  probe?: Partial<ProbeSpec> | undefined;
  log?: SnapshotLogger | undefined;
};

class DeadlineExceeded extends Error {}

const PROBE_NOTE =
  "Tradability is judged with a single small exact-input probe against the live quoter. It does not measure depth at larger sizes, the sell side is not probed, and a quote is not a trade authorization.";

/**
 * TTL-cached, single-in-flight market snapshot.
 *
 * GET /v1/market is the only unauthenticated /v1 path, and composing the catalogue is not
 * cheap: ChainReader.market() alone is roughly five metadata/feed reads plus a six-tick-spacing
 * quoter probe per asset, and this service adds one more quoter probe per asset on top. Serving
 * that per request would hand anyone a free RPC-exhaustion lever. Instead every concurrent
 * caller shares one refresh and the result is reused for the TTL, so request volume cannot
 * raise upstream load above roughly four refreshes a minute.
 */
export class MarketSnapshots {
  private cached: { at: number; snapshot: MarketSnapshot } | undefined;
  private pending: Promise<MarketSnapshot> | undefined;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly probe: ProbeSpec;
  private readonly log: SnapshotLogger | undefined;

  constructor(
    private readonly chain: ChainReader,
    private readonly assets: readonly Asset[],
    options: SnapshotOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
    this.deadlineMs = options.deadlineMs ?? SNAPSHOT_DEADLINE_MS;
    this.probe = {
      side: options.probe?.side ?? "buy",
      amount: options.probe?.amount ?? PROBE_NOTIONAL_USDC,
      slippageBps: options.probe?.slippageBps ?? PROBE_SLIPPAGE_BPS,
    };
    this.log = options.log;
  }

  async current(): Promise<MarketSnapshot> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs)
      return structuredClone(this.cached.snapshot);
    // Callers arriving mid-refresh join it instead of starting a second one.
    if (this.pending) return structuredClone(await this.pending);
    const pending = this.load();
    this.pending = pending;
    try {
      const snapshot = await pending;
      this.cached = { at: Date.now(), snapshot };
      // Cloned on the way out so a handler mutating its response cannot corrupt the cache.
      return structuredClone(snapshot);
    } finally {
      this.pending = undefined;
    }
  }

  private terms(): ProbeTerms {
    return {
      side: this.probe.side,
      amount: this.probe.amount,
      slippage_bps: this.probe.slippageBps,
      deviation_limit_bps: DEVIATION_LIMIT_BPS,
      note: PROBE_NOTE,
    };
  }

  /** Never rejects: a degraded chain produces a degraded snapshot, not a failed request. */
  private async load(): Promise<MarketSnapshot> {
    const deadline = Date.now() + this.deadlineMs;
    let feeds: MarketFeed[] = [];
    let reachable = true;
    try {
      feeds = await this.deadlined(this.chain.market(), deadline);
    } catch (error) {
      // BaseReader.market() degrades internally rather than throwing, so this is a different
      // reader or a hard timeout. Either way there is no reference to price anything against.
      reachable = false;
      this.warn("feeds", error);
    }
    const catalogue: CatalogueEntry[] = [];
    // Assets are probed one at a time, matching BaseReader's own burst bounding. Firing four
    // six-spacing quoter probes in parallel is what gets a public RPC endpoint to rate-limit
    // us, and the whole point of this service is that it runs at most four times a minute.
    for (const asset of this.assets) {
      const feed = feeds.find((entry) => entry.uri === `oracle:${asset.symbol}`);
      if (!reachable || Date.now() >= deadline) {
        catalogue.push(this.entry(asset, feed, null, true));
        continue;
      }
      let quote: Quote | null = null;
      let unreachable = false;
      try {
        quote = await this.deadlined(
          this.chain.quote(asset, this.probe.side, this.probe.amount, this.probe.slippageBps),
          deadline,
        );
      } catch (error) {
        // A revert, an empty pool and a 503 from the router are all "no route", not an error
        // worth failing the page over. Only a blown deadline means the chain itself is absent.
        unreachable = error instanceof DeadlineExceeded;
        this.warn(asset.symbol, error);
      }
      catalogue.push(this.entry(asset, feed, quote, unreachable));
    }
    return {
      as_of: new Date().toISOString(),
      feeds,
      catalogue,
      probe: this.terms(),
    };
  }

  private entry(
    asset: Asset,
    feed: MarketFeed | undefined,
    quote: Quote | null,
    unreachable: boolean,
  ): CatalogueEntry {
    return catalogueEntry({ asset, feed, quote, probe: this.probe, unreachable });
  }

  private async deadlined<T>(work: Promise<T>, deadline: number): Promise<T> {
    // The race abandons the loser; without this an upstream rejection arriving after the
    // timeout would surface as an unhandled rejection and take the process down.
    void work.catch(() => {});
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DeadlineExceeded();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DeadlineExceeded()), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private warn(stage: string, error: unknown) {
    // Upstream RPC error objects carry request bodies and endpoint URLs that can embed API
    // keys. Only the failure shape is ever logged.
    this.log?.warn(
      {
        stage,
        kind:
          error instanceof DeadlineExceeded
            ? "deadline"
            : error instanceof Problem
              ? error.code
              : "error",
      },
      "Market snapshot degraded",
    );
  }
}
