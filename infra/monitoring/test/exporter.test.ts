import { describe, expect, test } from "bun:test";
import { render } from "../exporter/metrics.js";
import type { CollectionState, MarketBody, ReadyBody, Route } from "../exporter/samples.js";
import {
  BLOCKERS,
  collect,
  EXPORTER_METRICS,
  MAX_SYMBOLS,
  NEVER_COLLECTED_SECONDS,
  ROUTES,
  referenceAgeSeconds,
  scoreStatus,
} from "../exporter/samples.js";

/**
 * The mapping from two JSON bodies to a metric exposition is the part of this exporter most
 * likely to be silently wrong -- a wrong unit or a swapped field produces a plausible number
 * that nobody questions until an alert does not fire. So it is the part with no I/O in it and
 * the part that gets a fixture.
 *
 * The clock is fixed. "40 hours old" has to be a testable statement, not something that
 * depends on which day the suite runs.
 */

const NOW_MS = Date.UTC(2026, 0, 4, 18, 0, 0);
const HOUR = 3600;
const at = (hours: number) => Math.floor(NOW_MS / 1000) - Math.round(hours * HOUR);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "AAPLc",
    nav: "320.08",
    nav_updated_at: at(40),
    nav_stale: true,
    tradable: true,
    reason: null,
    deviation_bps: "4.37",
    quote: { tick_spacing: 10 },
    ...overrides,
  };
}

const zeroCounters = () => ({
  requests: Object.fromEntries(ROUTES.map((route) => [route, 1])) as Record<Route, number>,
  responses: Object.fromEntries(
    ROUTES.map((route) => [route, { ok: 1, client_error: 0, server_error: 0, transport_error: 0 }]),
  ) as CollectionState["probes"]["responses"],
  durationSeconds: Object.fromEntries(ROUTES.map((route) => [route, 0.01])) as Record<
    Route,
    number
  >,
});

function state(overrides: Partial<CollectionState> = {}): CollectionState {
  const market: MarketBody = {
    as_of: new Date(NOW_MS - 4_000).toISOString(),
    catalogue: [entry()],
  };
  const ready: ReadyBody = {
    status: "ready",
    database: true,
    chain: true,
    execution_available: true,
  };
  return {
    nowMs: NOW_MS,
    lastSuccessMs: NOW_MS - 1_000,
    marketOk: true,
    market,
    ready,
    probes: zeroCounters(),
    collectionSeconds: 0.02,
    ...overrides,
  };
}

/** Every sample of one family, as `labelsKey -> value`. */
function family(families: ReturnType<typeof collect>, name: string) {
  const found = families.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no family ${name}`);
  return new Map(
    found.samples.map((sample) => [
      Object.values(sample.labels ?? {}).join("/") || "-",
      sample.value,
    ]),
  );
}

describe("reference age", () => {
  test("a weekend-old round reports its real age", () => {
    expect(referenceAgeSeconds(at(40), NOW_MS)).toBe(40 * HOUR);
  });

  test("an unread round is NaN, not 1.7 billion seconds", () => {
    // nav_updated_at is 0 when the oracle could not be read. 0 is a valid Unix timestamp, so
    // subtracting it yields a plausible-looking "very stale feed" and would send an operator
    // to inspect an aggregator when the fault is the RPC.
    expect(referenceAgeSeconds(0, NOW_MS)).toBeNaN();
    expect(referenceAgeSeconds(Number.NaN, NOW_MS)).toBeNaN();
    expect(referenceAgeSeconds(-1, NOW_MS)).toBeNaN();
  });

  test("a future timestamp clamps to zero rather than going negative", () => {
    // Matches assessRound in packages/evm/src/feeds/staleness.ts: within tolerated skew a
    // future round is "just published", never "negatively old".
    expect(referenceAgeSeconds(at(-1), NOW_MS)).toBe(0);
  });
});

describe("probe scoring", () => {
  test("503 from /ready is a correct answer, not a server error", () => {
    // The endpoint exists to shed traffic. Scoring this as an error would make the API error
    // rate fire alongside every database incident, on top of the readiness alert.
    expect(scoreStatus("/ready", 503)).toBe("ok");
    expect(scoreStatus("/ready", 200)).toBe("ok");
  });

  test("503 from /health is a server error", () => {
    // /health touches no dependency and is a static handler; it has no legitimate 503.
    expect(scoreStatus("/health", 503)).toBe("server_error");
  });

  test("a 4xx is scored, because the probe set is fixed and correct", () => {
    expect(scoreStatus("/v1/market", 404)).toBe("client_error");
    expect(scoreStatus("/v1/market", 429)).toBe("client_error");
  });

  test("an unexpected 2xx or 3xx is not treated as success", () => {
    // A redirect to a login page is something in front of the API answering on its behalf.
    expect(scoreStatus("/v1/market", 302)).toBe("server_error");
    expect(scoreStatus("/health", 204)).toBe("server_error");
  });
});

describe("catalogue mapping", () => {
  test("ages, availability and the API's own stale verdict are all published", () => {
    const families = collect(state());
    expect(family(families, "mandate_reference_age_seconds").get("AAPLc")).toBe(40 * HOUR);
    expect(family(families, "mandate_reference_available").get("AAPLc")).toBe(1);
    expect(family(families, "mandate_reference_stale").get("AAPLc")).toBe(1);
  });

  test("an unreadable feed is available=0 with a NaN age", () => {
    const families = collect(
      state({
        market: {
          as_of: new Date(NOW_MS).toISOString(),
          catalogue: [entry({ nav_updated_at: 0 })],
        },
      }),
    );
    expect(family(families, "mandate_reference_available").get("AAPLc")).toBe(0);
    expect(family(families, "mandate_reference_age_seconds").get("AAPLc")).toBeNaN();
  });

  test("blockers are one-hot across the full enum, including the zeroes", () => {
    const families = collect(
      state({
        market: {
          as_of: new Date(NOW_MS).toISOString(),
          catalogue: [
            entry({ tradable: false, reason: "no-priced-route", quote: null, deviation_bps: null }),
          ],
        },
      }),
    );
    const blocked = family(families, "mandate_asset_blocked");
    expect(blocked.size).toBe(BLOCKERS.length);
    expect(blocked.get("AAPLc/no-priced-route")).toBe(1);
    // The zeroes are the point: a query for one reason must return 0, never no data.
    expect(blocked.get("AAPLc/quote-deviation")).toBe(0);
    expect(family(families, "mandate_asset_tradable").get("AAPLc")).toBe(0);
  });

  test("an unrecognised blocker does not become a label", () => {
    const families = collect(
      state({
        market: {
          as_of: new Date(NOW_MS).toISOString(),
          catalogue: [entry({ tradable: false, reason: "something-new" })],
        },
      }),
    );
    const blocked = family(families, "mandate_asset_blocked");
    expect(blocked.size).toBe(BLOCKERS.length);
    expect([...blocked.values()].every((value) => value === 0)).toBe(true);
  });

  test("deviation arrives as a decimal string and is refused unless it is one", () => {
    const families = collect(
      state({
        market: {
          as_of: new Date(NOW_MS).toISOString(),
          catalogue: [
            entry({ symbol: "AAPLc", deviation_bps: "-12.10" }),
            entry({ symbol: "GOOGLc", deviation_bps: 4.37 }),
            entry({ symbol: "METAc", deviation_bps: "1e3" }),
            entry({ symbol: "NVDAc", deviation_bps: null }),
          ],
        },
      }),
    );
    const deviation = family(families, "mandate_asset_deviation_bps");
    expect(deviation.get("AAPLc")).toBe(-12.1);
    // A raw number is not what the API sends; accepting one would mask a contract change.
    expect(deviation.get("GOOGLc")).toBeNaN();
    // Exponent notation would parse to 1000 and read as a 10% deviation.
    expect(deviation.get("METAc")).toBeNaN();
    expect(deviation.get("NVDAc")).toBeNaN();
  });

  test("the tradable count is the measured baseline, not the listed count", () => {
    const catalogue = [
      entry({ symbol: "AAPLc" }),
      entry({ symbol: "GOOGLc" }),
      entry({ symbol: "METAc" }),
      entry({ symbol: "NVDAc" }),
      entry({ symbol: "TSLAc" }),
      entry({ symbol: "MSFTc", tradable: false, reason: "no-priced-route", quote: null }),
      entry({ symbol: "AMZNc", tradable: false, reason: "no-priced-route", quote: null }),
    ];
    const families = collect(
      state({ market: { as_of: new Date(NOW_MS).toISOString(), catalogue } }),
    );
    expect(family(families, "mandate_market_assets").get("-")).toBe(7);
    // Five of seven route on Base mainnet today; MSFTc and AMZNc do not.
    expect(family(families, "mandate_market_tradable_assets").get("-")).toBe(5);
  });

  test("duplicate and malformed symbols are dropped and counted, never emitted twice", () => {
    // Two samples with identical labels make Prometheus reject the ENTIRE scrape, so a
    // duplicate here would take every healthy metric down with it.
    const families = collect(
      state({
        market: {
          as_of: new Date(NOW_MS).toISOString(),
          catalogue: [entry(), entry(), entry({ symbol: "bad symbol!" }), entry({ symbol: 7 })],
        },
      }),
    );
    expect(family(families, "mandate_reference_age_seconds").size).toBe(1);
    expect(family(families, "mandate_market_symbols_dropped").get("-")).toBe(3);
  });

  test("the symbol cardinality ceiling holds", () => {
    const catalogue = Array.from({ length: MAX_SYMBOLS + 5 }, (_, index) =>
      entry({ symbol: `SYM${index}` }),
    );
    const families = collect(
      state({ market: { as_of: new Date(NOW_MS).toISOString(), catalogue } }),
    );
    expect(family(families, "mandate_market_assets").get("-")).toBe(MAX_SYMBOLS);
    expect(family(families, "mandate_market_symbols_dropped").get("-")).toBe(5);
  });
});

describe("degradation", () => {
  test("a missing market body produces zeroed counts, not a throw", () => {
    const families = collect(state({ market: undefined, ready: undefined, marketOk: false }));
    expect(family(families, "mandate_market_scrape_success").get("-")).toBe(0);
    expect(family(families, "mandate_market_assets").get("-")).toBe(0);
    expect(family(families, "mandate_api_ready").get("-")).toBe(0);
  });

  test("a collection that has never succeeded reports a day, not zero and not NaN", () => {
    // Zero would read as "collected just now" on the one occasion it is least true, and NaN
    // fails every comparison -- so MandateMarketExporterStale would stay silent for an
    // exporter that started while the API was down, which is precisely when it should speak.
    // Same resolution as metrics_worker() in infra/postgres/04-metrics.sql.
    const families = collect(state({ lastSuccessMs: Number.NaN }));
    expect(family(families, "mandate_market_last_success_age_seconds").get("-")).toBe(
      NEVER_COLLECTED_SECONDS,
    );
    expect(NEVER_COLLECTED_SECONDS).toBeGreaterThan(120);
  });

  test("readiness comes from the endpoint's own verdict", () => {
    const families = collect(
      state({
        ready: { status: "unavailable", database: false, chain: true, execution_available: false },
      }),
    );
    expect(family(families, "mandate_api_ready").get("-")).toBe(0);
    expect(family(families, "mandate_api_database_ready").get("-")).toBe(0);
    expect(family(families, "mandate_api_chain_ready").get("-")).toBe(1);
  });

  test("every probe outcome is emitted at zero so a rate() sees the first error", () => {
    const families = collect(state());
    const responses = family(families, "mandate_api_probe_responses_total");
    expect(responses.size).toBe(ROUTES.length * 4);
    expect(responses.get("/v1/market/server_error")).toBe(0);
  });
});

describe("exposition", () => {
  test("the rendered output parses as the metric set the alert rules expect", () => {
    const text = render(collect(state()));
    const names = new Set(
      [...text.matchAll(/^# TYPE (\S+) /gm)].flatMap((match) => (match[1] ? [match[1]] : [])),
    );
    expect([...names].sort()).toEqual([...EXPORTER_METRICS].sort());
  });

  test("no user data reaches the exposition", () => {
    // Label discipline, same rule as infra/postgres/04-metrics.sql: a metrics store has no
    // tenant boundary, so nothing that identifies a person or an address may enter it.
    const text = render(
      collect(
        state({
          market: {
            as_of: new Date(NOW_MS).toISOString(),
            catalogue: [entry({ token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })],
          },
        }),
      ),
    );
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text.split("\n").filter((line) => line.startsWith("#")).length).toBe(
      EXPORTER_METRICS.length * 2,
    );
  });

  test("NaN and Inf survive as themselves", () => {
    const text = render([
      {
        name: "mandate_test",
        type: "gauge",
        help: "x",
        samples: [{ value: Number.NaN }, { value: Number.POSITIVE_INFINITY }],
      },
    ]);
    expect(text).toContain("mandate_test NaN");
    expect(text).toContain("mandate_test +Inf");
  });

  test("label values are escaped and duplicate families are refused", () => {
    const text = render([
      {
        name: "mandate_test",
        type: "gauge",
        help: 'a "quoted" help\nline',
        samples: [{ labels: { reason: 'a"b\\c' }, value: 1 }],
      },
    ]);
    expect(text).toContain('reason="a\\"b\\\\c"');
    // HELP escapes backslash and newline only; escaping the quote there is the common
    // copy-paste error and shows up as a stray backslash in every dashboard tooltip.
    expect(text).toContain('# HELP mandate_test a "quoted" help\\nline');
    expect(() =>
      render([
        { name: "dup", type: "gauge", help: "h", samples: [] },
        { name: "dup", type: "gauge", help: "h", samples: [] },
      ]),
    ).toThrow();
  });

  test("an empty family still declares itself", () => {
    const text = render([{ name: "mandate_empty", type: "gauge", help: "h", samples: [] }]);
    expect(text).toBe("# HELP mandate_empty h\n# TYPE mandate_empty gauge\n");
  });
});
