import { createServer } from "node:http";
import { render } from "./metrics.js";
import {
  type CollectionState,
  collect,
  type MarketBody,
  type ProbeOutcome,
  type ReadyBody,
  ROUTES,
  type Route,
  scoreStatus,
} from "./samples.js";

/**
 * mandate-market-exporter: the Chainlink and API half of infra/monitoring.
 *
 * Run it beside the API (it talks to nothing else — no database handle, no RPC, no signer,
 * no credential of any kind, because everything it reads is on the one unauthenticated
 * route). infra/postgres/04-metrics.sql covers everything that lives in PostgreSQL; this
 * covers what does not.
 *
 *   bun infra/monitoring/exporter/main.ts
 *
 * Bun, not Node. Node 24 runs .ts by stripping types, but its resolver does not map a `./x.js`
 * specifier onto `./x.ts`, and this repository's ESM convention is that relative imports carry
 * `.js` even from `.ts` (see AGENTS.md). The API and worker only get away with `node` because
 * `bun scripts/dev/build-api.ts` bundles them first. Rather than add a fourth build target for
 * a 400-line sidecar, this one is run by the toolchain the repository already pins.
 *
 * Environment:
 *   MANDATE_API_URL       default http://127.0.0.1:8080
 *   EXPORTER_HOST         default 127.0.0.1   (loopback: this endpoint is unauthenticated)
 *   EXPORTER_PORT         default 9109
 *   EXPORTER_POLL_MS      default 15000
 *   EXPORTER_TIMEOUT_MS   default 12000
 */

/**
 * COLLECTION IS A BACKGROUND LOOP, NOT SOMETHING /metrics DOES ON DEMAND.
 *
 * The obvious design — fetch the API inside the scrape handler — has one fatal property:
 * when the API hangs, the scrape hangs, Prometheus times out, and it records nothing at all
 * for this job. Every metric that would have said "the API is failing" disappears at exactly
 * the moment it was needed, and the only surviving signal is `up == 0`, which cannot
 * distinguish "the API is broken" from "the exporter is broken".
 *
 * So /metrics always answers immediately from the last completed collection, and
 * `mandate_market_last_success_age_seconds` carries the age of that data. Stale numbers with
 * a stated age beat a blank scrape.
 */

/**
 * 15s, matching SNAPSHOT_TTL_MS in apps/api/src/modules/market/catalogue.ts. The API caches a
 * market snapshot for exactly that long, so polling faster returns byte-identical bytes while
 * still costing a request, and polling slower throws away resolution the API was willing to
 * give. It is also the Prometheus scrape interval in prometheus.yml, so a scrape sees at most
 * one collection of lag.
 */
const DEFAULT_POLL_MS = 15_000;

/**
 * 12s. A COLD market refresh is bounded by SNAPSHOT_DEADLINE_MS = 10s
 * (apps/api/src/modules/market/snapshot.ts): the API reads the oracle and probes the quoter
 * once per asset against a public RPC, and it deliberately takes up to ten seconds rather
 * than fail. A shorter timeout here would score the API's slowest LEGITIMATE response as a
 * transport error and fabricate an error rate out of a cold cache after every deploy. Two
 * seconds of headroom over that deadline, and still below the poll interval.
 */
const DEFAULT_TIMEOUT_MS = 12_000;

interface Options {
  apiUrl: string;
  host: string;
  port: number;
  pollMs: number;
  timeoutMs: number;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function options(): Options {
  const apiUrl = process.env.MANDATE_API_URL ?? "http://127.0.0.1:8080";
  // Parsed rather than string-concatenated: a trailing slash in the environment would
  // otherwise produce `//v1/market`, which Fastify's router answers with a 404 that this
  // exporter would faithfully report as a client error forever.
  const base = new URL(apiUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:")
    throw new Error("MANDATE_API_URL must be http or https");
  const pollMs = integer("EXPORTER_POLL_MS", DEFAULT_POLL_MS, 1_000, 300_000);
  const timeoutMs = integer("EXPORTER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 500, 60_000);
  if (timeoutMs >= pollMs)
    // Otherwise a wedged API leaves collections overlapping forever and the in-flight guard
    // below silently skips every subsequent cycle.
    throw new Error("EXPORTER_TIMEOUT_MS must be shorter than EXPORTER_POLL_MS");
  return {
    apiUrl: base.origin,
    // Loopback by default. /metrics is unauthenticated and, while it carries no user data by
    // construction, it does publish how many strategies are armed and whether execution is
    // available. Binding 0.0.0.0 is a decision, so it has to be typed out.
    host: process.env.EXPORTER_HOST ?? "127.0.0.1",
    port: integer("EXPORTER_PORT", 9109, 1, 65_535),
    pollMs,
    timeoutMs,
  };
}

/** JSON lines on stdout. Never an upstream error object: those carry URLs and headers. */
function log(level: "info" | "warn" | "error", message: string, fields: object = {}): void {
  process.stdout.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
}

const OUTCOMES = ["ok", "client_error", "server_error", "transport_error"] as const;

function zeroed<T extends number | Record<string, number>>(make: () => T): Record<Route, T> {
  return Object.fromEntries(ROUTES.map((route) => [route, make()])) as Record<Route, T>;
}

class Probes {
  readonly requests = zeroed<number>(() => 0);
  readonly responses = zeroed<Record<ProbeOutcome, number>>(
    () => Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<ProbeOutcome, number>,
  );
  readonly durationSeconds = zeroed<number>(() => Number.NaN);

  record(route: Route, outcome: ProbeOutcome, seconds: number): void {
    this.requests[route] += 1;
    this.responses[route][outcome] += 1;
    this.durationSeconds[route] = seconds;
  }
}

/**
 * One probe. Resolves to the parsed body, or undefined when the route did not answer usably.
 *
 * `AbortSignal.timeout` rather than a bare `Promise.race`: racing leaves the socket open and
 * the response streaming, so a wedged upstream accumulates one leaked connection per poll
 * until the process runs out of descriptors. Aborting actually tears the request down.
 */
async function probe(
  base: string,
  route: Route,
  timeoutMs: number,
  probes: Probes,
): Promise<unknown> {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${route}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    const outcome = scoreStatus(route, response.status);
    // The body is read even on an unexpected status so the connection is released rather
    // than left for the garbage collector to close on some later tick.
    const text = await response.text();
    probes.record(route, outcome, (Date.now() - started) / 1000);
    if (outcome !== "ok") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Well-formed HTTP, malformed JSON: the API is answering but not with what it claims.
      probes.responses[route].ok -= 1;
      probes.responses[route].server_error += 1;
      return undefined;
    }
  } catch {
    // Timeout, DNS, refused connection, TLS. Deliberately not logged with the caught value.
    probes.record(route, "transport_error", (Date.now() - started) / 1000);
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class Exporter {
  /**
   * Written out rather than declared as a constructor parameter property. Node 24 runs this
   * file by STRIPPING types, which requires erasable syntax only, and a parameter property
   * emits a real assignment — `node infra/monitoring/exporter/main.ts` fails at parse with
   * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Same reason there is no `enum` in this directory.
   */
  private readonly config: Options;
  private readonly probes = new Probes();
  private market: MarketBody | undefined;
  private ready: ReadyBody | undefined;
  private marketOk = false;
  private lastSuccessMs = Number.NaN;
  private collectionSeconds = Number.NaN;
  private collecting = false;

  constructor(config: Options) {
    this.config = config;
  }

  /**
   * One collection cycle. Never rejects and never overlaps itself — the in-flight guard is
   * the same shape as the worker's heartbeat interval in apps/worker/src/main.ts, and for the
   * same reason: a slow upstream must not turn a fixed-rate loop into unbounded concurrency.
   */
  async collectOnce(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    const started = Date.now();
    try {
      const [ready, market] = await Promise.all([
        probe(this.config.apiUrl, "/ready", this.config.timeoutMs, this.probes),
        probe(this.config.apiUrl, "/v1/market", this.config.timeoutMs, this.probes),
      ]);
      // /health is probed separately and last: it touches no dependency, so it is the one
      // signal that distinguishes "the process is gone" from "the process cannot reach
      // PostgreSQL". Bundling it into the Promise.all above would make a slow /v1/market
      // delay that answer by up to the full timeout.
      await probe(this.config.apiUrl, "/health", this.config.timeoutMs, this.probes);

      if (isObject(ready)) this.ready = ready as ReadyBody;
      // A catalogue is what this exporter exists to publish; a 200 without one is not a
      // success, however well-formed the rest of the body is.
      const usable = isObject(market) && Array.isArray((market as MarketBody).catalogue);
      if (usable) {
        this.market = market as MarketBody;
        this.lastSuccessMs = Date.now();
      }
      this.marketOk = usable;
      if (!usable) log("warn", "Market collection produced no catalogue");
    } finally {
      this.collectionSeconds = (Date.now() - started) / 1000;
      this.collecting = false;
    }
  }

  /**
   * The previous collection's values are kept on failure rather than cleared. Clearing would
   * make a five-second network blip look identical to "every Chainlink feed vanished", which
   * is a page. `mandate_market_scrape_success` and the last-success age report the doubt.
   */
  expose(nowMs: number = Date.now()): string {
    const state: CollectionState = {
      nowMs,
      lastSuccessMs: this.lastSuccessMs,
      marketOk: this.marketOk,
      market: this.market,
      ready: this.ready,
      probes: this.probes,
      collectionSeconds: this.collectionSeconds,
    };
    return render(collect(state));
  }
}

async function main(): Promise<void> {
  const config = options();
  const exporter = new Exporter(config);
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/metrics") {
      const body = exporter.expose();
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (path === "/health") {
      // The exporter's own liveness, and deliberately not a function of whether the API is
      // up: an orchestrator restarting this process during an API outage destroys the only
      // record of the outage.
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}\n');
      return;
    }
    response.writeHead(404).end();
  });

  // First collection before listening, so the very first scrape carries real data instead of
  // a full set of zeroes that a `== 0` alert would read as an incident.
  await exporter.collectOnce();
  const timer = setInterval(() => {
    void exporter.collectOnce();
  }, config.pollMs);

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  log("info", "Exporter started", { port: config.port, pollMs: config.pollMs });

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      clearInterval(timer);
      server.close(() => log("info", "Exporter stopped"));
      // Sockets kept alive by Prometheus would otherwise hold the process open past the
      // orchestrator's grace period and turn a clean stop into a SIGKILL.
      server.closeAllConnections?.();
    });
}

// `import.meta.main` is Bun; `process.argv[1]` is the Node path. Guarded so the test can
// import Exporter without starting a listener.
const entry = process.argv[1] ?? "";
if (entry.endsWith("main.ts") || entry.endsWith("main.js"))
  main().catch(() => {
    log("error", "Exporter failed to start; check MANDATE_API_URL and EXPORTER_PORT");
    process.exitCode = 1;
  });
