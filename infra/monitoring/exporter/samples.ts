import type { MetricFamily, Sample } from "./metrics.js";

/**
 * Turns two public API responses into metric families. Pure: no clock of its own, no
 * network, no process state. Everything time-dependent arrives as `nowMs`, so the weekend
 * staleness case that this whole file exists for is testable without waiting for a weekend.
 *
 * WHY AN EXPORTER AT ALL, when infra/postgres/04-metrics.sql already covers the database.
 * The database knows nothing about Chainlink. It stores what the worker decided, not what
 * the worker read, so feed age — the single input that decides whether anything can be
 * priced — has exactly one observable source outside the chain itself: `GET /v1/market`,
 * which is the only unauthenticated /v1 route (apps/api/src/plugins/authentication.ts).
 *
 * prometheus-community/json_exporter was the obvious zero-code alternative and was rejected
 * for three reasons: `deviation_bps` arrives as a decimal string and jsonpath cannot convert
 * it, the blocker reason is an enum that has to be one-hot encoded to stay queryable, and a
 * jsonpath expression cannot be unit-tested against a fixture in this repo. The mapping
 * below is the part most likely to be silently wrong, so it is the part that gets tests.
 */

/** Every value `CatalogueEntry.reason` can take (apps/api/src/modules/market/catalogue.ts). */
export const BLOCKERS = [
  "reference-unavailable",
  "reference-stale",
  "no-priced-route",
  "quote-deviation",
  "chain-unavailable",
] as const;
export type Blocker = (typeof BLOCKERS)[number];

/** Routes this exporter probes. Bounded set: `route` is a metric label. */
export const ROUTES = ["/health", "/ready", "/v1/market"] as const;
export type Route = (typeof ROUTES)[number];

/**
 * How a probe's HTTP response is scored for the error-rate alert.
 *
 * `GET /ready` answers 503 when a dependency is down, and that is a CORRECT answer, not a
 * fault: the endpoint's whole job is to say "do not route traffic here"
 * (apps/api/src/modules/health/routes.ts). Counting it as a server error would make the API
 * error-rate alert fire during every database incident on top of the readiness alert that
 * already fired, and — worse — it would make a permanently-degraded chain RPC look like an
 * application defect for as long as it lasted. So `outcome` is scored per route against the
 * statuses that route is allowed to return, not against the 2xx/5xx split.
 */
export type ProbeOutcome = "ok" | "client_error" | "server_error" | "transport_error";

const EXPECTED_STATUS: Readonly<Record<Route, readonly number[]>> = {
  "/health": [200],
  // 200 ready, 503 unready. Both mean the process answered.
  "/ready": [200, 503],
  "/v1/market": [200],
};

export function scoreStatus(route: Route, status: number): ProbeOutcome {
  if (EXPECTED_STATUS[route].includes(status)) return "ok";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  // A 2xx or 3xx the route is not supposed to produce is still the server behaving
  // unexpectedly; scoring it `ok` would hide a misrouted reverse proxy answering for us.
  return "server_error";
}

/**
 * Ceiling on distinct `symbol` label values.
 *
 * The catalogue is seven B20 equities and is compiled into the API, so this can only trip if
 * the exporter is pointed at something that is not this API. Prometheus has no per-scrape
 * cardinality limit by default, and a scrape that invents ten thousand series does not fail
 * loudly — it degrades the whole TSDB for every other job on the server. Truncating and
 * publishing the drop count fails visibly instead.
 */
export const MAX_SYMBOLS = 64;

/** Matches the API's own `symbol` bound (`z.string().max(24)` in the quote schema). */
const SYMBOL = /^[A-Za-z0-9._-]{1,24}$/;

export interface ReadyBody {
  status?: unknown;
  database?: unknown;
  chain?: unknown;
  execution_available?: unknown;
}

export interface CatalogueEntryBody {
  symbol?: unknown;
  nav_updated_at?: unknown;
  nav_stale?: unknown;
  tradable?: unknown;
  reason?: unknown;
  deviation_bps?: unknown;
  quote?: { tick_spacing?: unknown } | null | undefined;
}

export interface MarketBody {
  as_of?: unknown;
  catalogue?: unknown;
}

export interface ProbeCounters {
  /** Requests started, per route. Monotonic for the life of the process. */
  readonly requests: Readonly<Record<Route, number>>;
  /** Responses scored, per route and outcome. */
  readonly responses: Readonly<Record<Route, Readonly<Record<ProbeOutcome, number>>>>;
  /** Wall time of the most recent completed attempt, per route. NaN before the first. */
  readonly durationSeconds: Readonly<Record<Route, number>>;
}

export interface CollectionState {
  readonly nowMs: number;
  /** Epoch ms of the last collection in which BOTH probes succeeded. NaN before the first. */
  readonly lastSuccessMs: number;
  /** Did the most recent collection produce a usable market body? */
  readonly marketOk: boolean;
  readonly market: MarketBody | undefined;
  readonly ready: ReadyBody | undefined;
  readonly probes: ProbeCounters;
  readonly collectionSeconds: number;
}

/**
 * The complete set of metric names this exporter can emit.
 *
 * Exported so the alert-rule test can assert that every metric an alert selects is one
 * something actually produces. An alert on a metric no exporter emits never fires and never
 * warns you that it never fires — it is worse than no alert, because it occupies the
 * "we have coverage for that" slot in an operator's head.
 */
export const EXPORTER_METRICS = [
  "mandate_api_probe_requests_total",
  "mandate_api_probe_responses_total",
  "mandate_api_probe_duration_seconds",
  "mandate_api_ready",
  "mandate_api_database_ready",
  "mandate_api_chain_ready",
  "mandate_api_execution_available",
  "mandate_market_scrape_success",
  "mandate_market_last_success_age_seconds",
  "mandate_market_snapshot_age_seconds",
  "mandate_market_assets",
  "mandate_market_symbols_dropped",
  "mandate_market_tradable_assets",
  "mandate_reference_age_seconds",
  "mandate_reference_available",
  "mandate_reference_stale",
  "mandate_asset_tradable",
  "mandate_asset_blocked",
  "mandate_asset_deviation_bps",
  "mandate_asset_quote_tick_spacing",
  "mandate_exporter_collection_duration_seconds",
] as const;

function flag(value: unknown): number {
  return value === true ? 1 : 0;
}

/** A finite number, or NaN. Never a coerced string: `Number("")` is 0 and that lies. */
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/**
 * `deviation_bps` crosses the wire as a decimal string with two places, because the API
 * computes it in decimal.js precisely so it never touches binary floating point
 * (apps/api/src/modules/market/catalogue.ts). Converting it here is a deliberate, local
 * loss: it is a dimensionless ratio used for a threshold comparison, not an amount anyone
 * settles against, and Prometheus has no other numeric type. The regex refuses anything that
 * is not a plain signed decimal so a hex string or `Infinity` cannot become a plausible
 * reading.
 */
const DECIMAL = /^-?\d{1,12}(\.\d{1,18})?$/;
function decimalToNumber(value: unknown): number {
  if (typeof value !== "string" || !DECIMAL.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

interface Entry {
  symbol: string;
  navUpdatedAt: number;
  navStale: boolean;
  tradable: boolean;
  reason: Blocker | undefined;
  deviationBps: number;
  tickSpacing: number;
}

function readEntries(body: MarketBody | undefined): { entries: Entry[]; dropped: number } {
  const raw = Array.isArray(body?.catalogue) ? body.catalogue : [];
  const entries: Entry[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of raw as CatalogueEntryBody[]) {
    const symbol = typeof item?.symbol === "string" ? item.symbol : "";
    // Duplicates are dropped rather than summed: two samples with identical labels in one
    // exposition make Prometheus reject the entire scrape.
    if (!SYMBOL.test(symbol) || seen.has(symbol) || entries.length >= MAX_SYMBOLS) {
      dropped++;
      continue;
    }
    seen.add(symbol);
    const reason = BLOCKERS.find((blocker) => blocker === item.reason);
    entries.push({
      symbol,
      navUpdatedAt: finite(item.nav_updated_at),
      navStale: item.nav_stale === true,
      tradable: item.tradable === true,
      reason,
      deviationBps: decimalToNumber(item.deviation_bps),
      tickSpacing: finite(item.quote?.tick_spacing),
    });
  }
  return { entries, dropped };
}

/**
 * Age of a Chainlink round, in seconds, or NaN when there is no round.
 *
 * `nav_updated_at` is 0 when the oracle could not be read at all, and 0 is a real Unix
 * timestamp: subtracting it yields ~1.79e9 seconds, which is a perfectly plausible-looking
 * "very stale feed" and would fire the staleness alert for the wrong reason, sending an
 * operator to look at an aggregator when the actual fault is the RPC. Unreadable is
 * `mandate_reference_available == 0` and NaN age; old is a number.
 *
 * A future timestamp clamps to 0 rather than going negative, matching `assessRound` in
 * packages/evm/src/feeds/staleness.ts. This exporter's clock is not the chain's.
 */
export function referenceAgeSeconds(navUpdatedAt: number, nowMs: number): number {
  if (!Number.isFinite(navUpdatedAt) || navUpdatedAt <= 0) return Number.NaN;
  return Math.max(0, Math.floor(nowMs / 1000) - navUpdatedAt);
}

function ageSeconds(fromMs: number, nowMs: number): number {
  if (!Number.isFinite(fromMs)) return Number.NaN;
  return Math.max(0, (nowMs - fromMs) / 1000);
}

export function collect(state: CollectionState): MetricFamily[] {
  const { entries, dropped } = readEntries(state.market);
  const ready = state.ready;

  const perSymbol = (pick: (entry: Entry) => number): Sample[] =>
    entries.map((entry) => ({ labels: { symbol: entry.symbol }, value: pick(entry) }));

  const snapshotAge = (() => {
    const asOf = typeof state.market?.as_of === "string" ? Date.parse(state.market.as_of) : NaN;
    return ageSeconds(asOf, state.nowMs);
  })();

  const probeSamples: Sample[] = [];
  const responseSamples: Sample[] = [];
  const durationSamples: Sample[] = [];
  for (const route of ROUTES) {
    probeSamples.push({ labels: { route }, value: state.probes.requests[route] });
    durationSamples.push({ labels: { route }, value: state.probes.durationSeconds[route] });
    // Every outcome is emitted for every route, including the zeroes. `rate()` over a
    // counter that only appears once it is non-zero treats its first appearance as a reset
    // and reports no increase, so the first burst of errors — the one that matters — is the
    // one an error-rate alert would miss.
    for (const outcome of ["ok", "client_error", "server_error", "transport_error"] as const)
      responseSamples.push({
        labels: { route, outcome },
        value: state.probes.responses[route][outcome],
      });
  }

  return [
    {
      name: "mandate_api_probe_requests_total",
      type: "counter",
      help: "Probe requests this exporter has issued, by API route.",
      samples: probeSamples,
    },
    {
      name: "mandate_api_probe_responses_total",
      type: "counter",
      help: "Probe responses by route and outcome. A 503 from /ready scores ok: refusing traffic is that route's correct answer, not an API fault.",
      samples: responseSamples,
    },
    {
      name: "mandate_api_probe_duration_seconds",
      type: "gauge",
      help: "Wall time of the most recent probe of each route. NaN before the first attempt.",
      samples: durationSamples,
    },
    {
      name: "mandate_api_ready",
      type: "gauge",
      help: "GET /ready verdict: 1 when the API should receive traffic.",
      // The endpoint's own word for it, not a re-derivation from `database && chain`. If the
      // API ever adds a third dependency to that conjunction, re-deriving here would keep
      // reporting ready while the API returned 503 to the load balancer.
      samples: [{ value: ready?.status === "ready" ? 1 : 0 }],
    },
    {
      name: "mandate_api_database_ready",
      type: "gauge",
      help: "PostgreSQL is reachable, migrated, and not reached through a superuser role.",
      samples: [{ value: flag(ready?.database) }],
    },
    {
      name: "mandate_api_chain_ready",
      type: "gauge",
      help: "The Base RPC answers and reports chain id 8453.",
      samples: [{ value: flag(ready?.chain) }],
    },
    {
      name: "mandate_api_execution_available",
      type: "gauge",
      help: "A live execution-enabled worker heartbeat, as the API publishes it. Never a reason for the API to fail readiness.",
      samples: [{ value: flag(ready?.execution_available) }],
    },
    {
      name: "mandate_market_scrape_success",
      type: "gauge",
      help: "1 when the most recent GET /v1/market returned a usable catalogue.",
      samples: [{ value: state.marketOk ? 1 : 0 }],
    },
    {
      name: "mandate_market_last_success_age_seconds",
      type: "gauge",
      help: "Seconds since the last fully successful collection. This is what proves the numbers below are current; every per-symbol gauge keeps its last value while collection is failing.",
      samples: [{ value: ageSeconds(state.lastSuccessMs, state.nowMs) }],
    },
    {
      name: "mandate_market_snapshot_age_seconds",
      type: "gauge",
      help: "Age of the API's own market snapshot (as_of). Oscillates within its 15s cache TTL; a monotonic climb means the refresh is wedged.",
      samples: [{ value: snapshotAge }],
    },
    {
      name: "mandate_market_assets",
      type: "gauge",
      help: "Catalogue entries returned by the API.",
      samples: [{ value: entries.length }],
    },
    {
      name: "mandate_market_symbols_dropped",
      type: "gauge",
      help: "Catalogue entries this exporter refused: malformed symbol, duplicate, or past the cardinality ceiling.",
      samples: [{ value: dropped }],
    },
    {
      name: "mandate_market_tradable_assets",
      type: "gauge",
      help: "Catalogue entries with a quote inside the 500 bps reference band.",
      samples: [{ value: entries.filter((entry) => entry.tradable).length }],
    },
    {
      name: "mandate_reference_age_seconds",
      type: "gauge",
      help: "Age of the Chainlink round backing each asset. NaN when the feed could not be read at all; compare against the 96h validation bound, never the 26h display bound.",
      samples: perSymbol((entry) => referenceAgeSeconds(entry.navUpdatedAt, state.nowMs)),
    },
    {
      name: "mandate_reference_available",
      type: "gauge",
      help: "1 when a Chainlink round was read for this asset, regardless of its age.",
      samples: perSymbol((entry) => (entry.navUpdatedAt > 0 ? 1 : 0)),
    },
    {
      name: "mandate_reference_stale",
      type: "gauge",
      help: "The API's own 26h display verdict. DIAGNOSTIC ONLY: every symbol is 1 for the whole of every weekend by design. Do not alert on this.",
      samples: perSymbol((entry) => (entry.navStale ? 1 : 0)),
    },
    {
      name: "mandate_asset_tradable",
      type: "gauge",
      help: "1 when the small exact-input probe produced a quote inside the reference band.",
      samples: perSymbol((entry) => (entry.tradable ? 1 : 0)),
    },
    {
      name: "mandate_asset_blocked",
      type: "gauge",
      help: "One-hot: why an asset is not tradable. Every reason is emitted for every symbol so a query for one reason cannot silently return no data.",
      samples: entries.flatMap((entry) =>
        BLOCKERS.map((reason) => ({
          labels: { symbol: entry.symbol, reason },
          value: entry.reason === reason ? 1 : 0,
        })),
      ),
    },
    {
      name: "mandate_asset_deviation_bps",
      type: "gauge",
      help: "Signed basis points between the probe price and the Chainlink reference. The router refuses at 500.",
      samples: perSymbol((entry) => entry.deviationBps),
    },
    {
      name: "mandate_asset_quote_tick_spacing",
      type: "gauge",
      help: "Aerodrome Slipstream tick spacing the best quote came from. AAPLc/USDC prices correctly at 10 and 11,729% out at 200, so which pool is being routed through is worth watching.",
      samples: perSymbol((entry) => entry.tickSpacing),
    },
    {
      name: "mandate_exporter_collection_duration_seconds",
      type: "gauge",
      help: "Wall time of the most recent collection cycle.",
      samples: [{ value: state.collectionSeconds }],
    },
  ];
}
