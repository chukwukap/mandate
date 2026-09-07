import { afterEach, expect, test } from "bun:test";
import {
  type Asset,
  type ChainReader,
  type MarketFeed,
  Problem,
  type Quote,
} from "@mandate/contracts";
import { ASSETS, CHAIN_ID } from "@mandate/evm";
import { Decimal } from "decimal.js";
import Fastify, { type FastifyInstance } from "fastify";
import {
  catalogueEntry,
  deviationBps,
  impliedPrice,
  type MarketDependencies,
  MarketSnapshots,
  REFERENCE_NOTICE,
  registerMarket,
} from "../src/modules/market/index.js";

const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });
const AAPL = ASSETS[0] as Asset;
const probe = { side: "buy" as const, amount: "10", slippageBps: 50 };
// 10 USDC in, 0.03122852 AAPLc out => 320.2201... USDC/share against a 320.08 NAV.
const TEN_USDC = "10000000";
const HEALTHY_OUT = "3122852";
const NAV = "320.08";
const HEALTHY_PRICE = "320.220106";

function oracle(symbol: string, value: string | null, overrides: Partial<MarketFeed> = {}) {
  return {
    uri: `oracle:${symbol}`,
    value,
    updated_at: 1_757_000_000,
    stale: false,
    ...overrides,
  } satisfies MarketFeed;
}
function quoteOf(overrides: Partial<Quote> = {}): Quote {
  return {
    token_in: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    token_out: AAPL.token,
    amount_in: TEN_USDC,
    amount_out: HEALTHY_OUT,
    min_out: "3107237",
    tick_spacing: 10,
    expires_at: new Date(Date.now() + 20_000).toISOString(),
    reference: NAV,
    ...overrides,
  };
}

type Calls = { market: number; quote: string[] };
function reader(
  handlers: {
    market?: () => Promise<MarketFeed[]>;
    quote?: (asset: Asset, side: "buy" | "sell", amount: string) => Promise<Quote>;
  } = {},
) {
  const calls: Calls = { market: 0, quote: [] };
  const chain: ChainReader = {
    ready: async () => true,
    market: async () => {
      calls.market += 1;
      return handlers.market
        ? await handlers.market()
        : ASSETS.map((asset) => oracle(asset.symbol, NAV));
    },
    quote: async (asset, side, amount) => {
      calls.quote.push(asset.symbol);
      if (!handlers.quote) throw Problem.unavailable("No route");
      return handlers.quote(asset, side, amount);
    },
    walletKind: async () => "eoa",
    permissionStatus: async () => ({ approved: false, revoked: false }),
    verifyMessage: async () => false,
    verifyPermission: async () => false,
  };
  return { chain, calls };
}

const opened: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

// A minimal stand-in for app.ts: the same request decorators and the same Problem -> RFC7807
// mapping, so the routes are exercised over real HTTP without depending on app.ts wiring
// (which another process owns) or colliding with the copies still live in strategies/routes.ts.
async function harness(deps: Partial<MarketDependencies> & { eligible?: boolean } = {}) {
  const fallback = reader();
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.decorateRequest("principal", null);
  app.decorateRequest("jurisdiction", "GB");
  app.decorateRequest("eligible", false);
  app.addHook("onRequest", async (request) => {
    request.eligible = deps.eligible ?? true;
  });
  app.setErrorHandler((error, _request, reply) => {
    const problem =
      error instanceof Problem
        ? error
        : new Problem(400, "invalid-request", "Invalid request", "Schema mismatch.");
    void reply
      .code(problem.status)
      .type("application/problem+json")
      .send({ status: problem.status, code: problem.code, detail: problem.detail });
  });
  await registerMarket(app, {
    chain: deps.chain ?? fallback.chain,
    assets: deps.assets ?? ASSETS,
    executionAvailable: deps.executionAvailable ?? (async () => true),
    snapshots: deps.snapshots,
  });
  opened.push(app);
  return app;
}

function only<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected at least one catalogue entry");
  return row;
}

function entryFor(body: { catalogue: Array<{ symbol: string }> }, symbol: string) {
  const found = body.catalogue.find((row) => row.symbol === symbol);
  if (!found) throw new Error(`missing catalogue entry ${symbol}`);
  return found as ReturnType<typeof catalogueEntry>;
}

test("GET /v1/market keeps the legacy response shape apps/web reads", async () => {
  const feeds = [oracle("AAPLc", NAV)];
  const { chain } = reader({ market: async () => feeds });
  const app = await harness({ chain, assets: [AAPL], executionAvailable: async () => true });
  const response = await app.inject({ url: "/v1/market" });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.chain_id).toBe(CHAIN_ID);
  expect(body.assets).toEqual([AAPL]);
  expect(body.feeds).toEqual(feeds);
  expect(body.execution_available).toBe(true);
  expect(body.reference_notice).toBe(REFERENCE_NOTICE);
  expect(body.reference_notice).toBe(
    "Reference feeds can hold the last close during closed sessions or corporate-action pauses. A quote is not a trade authorization.",
  );
});

test("a healthy asset prices off its 8 decimals and reports a small signed deviation", async () => {
  const { chain } = reader({
    market: async () => [oracle("AAPLc", NAV)],
    quote: async () => quoteOf(),
  });
  const app = await harness({ chain, assets: [AAPL] });
  const body = (await app.inject({ url: "/v1/market" })).json();
  const entry = entryFor(body, "AAPLc");
  expect(entry.tradable).toBe(true);
  expect(entry.reason).toBeNull();
  expect(entry.decimals).toBe(8);
  expect(entry.quote?.price).toBe(HEALTHY_PRICE);
  // Reading the 8-decimal output as 18 decimals would put the price near 3.2e12 instead.
  expect(Number(entry.quote?.price)).toBeGreaterThan(319);
  expect(Number(entry.quote?.price)).toBeLessThan(321);
  expect(entry.deviation_bps).toBe("4.38");
  expect(entry.nav).toBe(NAV);
  expect(entry.nav_source).toBe("quote");
  expect(entry.quote?.tick_spacing).toBe(10);
  expect(response_has_no_float_poison(body)).toBe(true);
});

function response_has_no_float_poison(body: unknown) {
  const text = JSON.stringify(body);
  return !text.includes("NaN") && !text.includes("Infinity");
}

test("the catalogue price is byte-identical to the dex feed for the same probe", async () => {
  // Mirrors BaseReader.assetMarket: the dex feed is 10 / formatUnits(amount_out, decimals),
  // rounded down to USDC precision. The rounding is part of what is mirrored — the invariant is
  // that both paths publish the SAME string, so a fixture at full precision would assert an
  // agreement the production code no longer has.
  const { chain } = reader({
    market: async () => [
      oracle("AAPLc", NAV),
      {
        uri: "dex:AAPLc",
        value: new Money(10)
          .div(new Money(HEALTHY_OUT).div(new Money(10).pow(8)))
          .toDecimalPlaces(6, Decimal.ROUND_DOWN)
          .toFixed(),
        updated_at: 1_757_000_001,
        stale: false,
      },
    ],
    quote: async () => quoteOf(),
  });
  const app = await harness({ chain, assets: [AAPL] });
  const body = (await app.inject({ url: "/v1/market" })).json();
  const dex = (body.feeds as MarketFeed[]).find((feed) => feed.uri === "dex:AAPLc")?.value ?? null;
  expect(dex).toBe(HEALTHY_PRICE);
  expect(entryFor(body, "AAPLc").quote?.price).toBe(HEALTHY_PRICE);
});

test("a wildly mispriced pool is reported as not tradable, never omitted", async () => {
  // 0.025 AAPLc for 10 USDC is $400/share: the shape of the tick-spacing-200 trap.
  const { chain } = reader({
    market: async () => [oracle("AAPLc", NAV)],
    quote: async () => quoteOf({ amount_out: "2500000", tick_spacing: 200 }),
  });
  const app = await harness({ chain, assets: [AAPL] });
  const body = (await app.inject({ url: "/v1/market" })).json();
  const entry = entryFor(body, "AAPLc");
  expect(body.catalogue).toHaveLength(1);
  expect(entry.tradable).toBe(false);
  expect(entry.reason).toBe("quote-deviation");
  expect(entry.deviation_bps).toBe("2496.88");
  // The rejected quote is still shown so the UI can say what it saw.
  expect(entry.quote?.price).toBe("400");
  expect(entry.detail).toContain("2496.88 bps");
  expect(entry.detail).toContain("400");
});

test("a reverting route is not-tradable with a reason, and the oracle still supplies NAV", async () => {
  const { chain } = reader({ market: async () => [oracle("AAPLc", NAV)] });
  const app = await harness({ chain, assets: [AAPL] });
  const entry = entryFor((await app.inject({ url: "/v1/market" })).json(), "AAPLc");
  expect(entry.tradable).toBe(false);
  expect(entry.reason).toBe("no-priced-route");
  expect(entry.quote).toBeNull();
  expect(entry.deviation_bps).toBeNull();
  expect(entry.nav).toBe(NAV);
  expect(entry.nav_source).toBe("oracle");
  expect(entry.detail).toContain("10 USDC buy");
});

test("stale and missing references produce distinct reasons", async () => {
  const { chain } = reader({
    market: async () => [
      oracle("AAPLc", NAV, { stale: true }),
      oracle("GOOGLc", null, { updated_at: 0, stale: true }),
    ],
  });
  const app = await harness({ chain, assets: [AAPL, ASSETS[1] as Asset] });
  const body = (await app.inject({ url: "/v1/market" })).json();
  expect(entryFor(body, "AAPLc").reason).toBe("reference-stale");
  expect(entryFor(body, "AAPLc").nav_stale).toBe(true);
  expect(entryFor(body, "GOOGLc").reason).toBe("reference-unavailable");
  expect(entryFor(body, "GOOGLc").nav).toBeNull();
});

test("an unreachable chain reports every asset as chain-unavailable without probing", async () => {
  const { chain, calls } = reader({
    market: async () => {
      throw new Error("rpc down");
    },
  });
  const app = await harness({ chain, assets: ASSETS });
  const body = (await app.inject({ url: "/v1/market" })).json();
  expect(body.catalogue).toHaveLength(ASSETS.length);
  for (const entry of body.catalogue) {
    expect(entry.tradable).toBe(false);
    expect(entry.reason).toBe("chain-unavailable");
  }
  // No quoter probe is issued when there is no reference to validate against.
  expect(calls.quote).toEqual([]);
});

test("concurrent callers share one refresh instead of multiplying RPC load", async () => {
  const { chain, calls } = reader({
    market: async () => [oracle("AAPLc", NAV)],
    quote: async () => quoteOf(),
  });
  const app = await harness({ chain, assets: [AAPL] });
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => app.inject({ url: "/v1/market" })),
  );
  for (const response of responses) expect(response.statusCode).toBe(200);
  expect(calls.market).toBe(1);
  expect(calls.quote).toEqual(["AAPLc"]);
});

test("the snapshot refreshes once the TTL lapses and hands out isolated copies", async () => {
  const { chain, calls } = reader({
    market: async () => [oracle("AAPLc", NAV)],
    quote: async () => quoteOf(),
  });
  const snapshots = new MarketSnapshots(chain, [AAPL], { ttlMs: 25 });
  const first = await snapshots.current();
  only(first.catalogue).tradable = false;
  const second = await snapshots.current();
  expect(only(second.catalogue).tradable).toBe(true);
  expect(calls.market).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await snapshots.current();
  expect(calls.market).toBe(2);
});

test("a probe that outlives the deadline degrades instead of hanging the public route", async () => {
  const { chain, calls } = reader({
    market: async () => ASSETS.map((asset) => oracle(asset.symbol, NAV)),
    quote: () => new Promise<Quote>(() => {}),
  });
  const snapshots = new MarketSnapshots(chain, ASSETS, { deadlineMs: 30 });
  const started = Date.now();
  const snapshot = await snapshots.current();
  expect(Date.now() - started).toBeLessThan(2000);
  for (const entry of snapshot.catalogue) expect(entry.reason).toBe("chain-unavailable");
  // The first probe consumes the deadline; the rest are skipped rather than each waiting.
  expect(calls.quote).toEqual(["AAPLc"]);
  expect(only(snapshot.catalogue).nav).toBe(NAV);
});

test("the probe terms are stated so the verdict is never read as size-independent", async () => {
  const app = await harness({ assets: [AAPL] });
  const body = (await app.inject({ url: "/v1/market" })).json();
  expect(body.probe).toMatchObject({
    side: "buy",
    amount: "10",
    slippage_bps: 50,
    deviation_limit_bps: 500,
  });
  expect(body.probe.note).toContain("not measure depth");
  expect(typeof body.as_of).toBe("string");
  expect(Number.isNaN(Date.parse(body.as_of))).toBe(false);
});

test("a database outage degrades execution_available rather than failing the public route", async () => {
  const app = await harness({
    assets: [AAPL],
    executionAvailable: async () => {
      throw new Error("pool exhausted");
    },
  });
  const response = await app.inject({ url: "/v1/market" });
  expect(response.statusCode).toBe(200);
  expect(response.json().execution_available).toBe(false);
});

test("quote rejects ineligible callers before it looks up the symbol", async () => {
  const app = await harness({ eligible: false, assets: [AAPL] });
  const response = await app.inject({
    method: "POST",
    url: "/v1/market/quote",
    payload: { symbol: "TSLAc", side: "buy", amount: "10" },
  });
  // An eligible caller would get 400 unknown-asset here; an ineligible one learns nothing.
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe("not-eligible");
});

test("a malformed quote body is rejected by the route schema, ahead of the handler", async () => {
  const app = await harness({ assets: [AAPL] });
  const response = await app.inject({
    method: "POST",
    url: "/v1/market/quote",
    payload: { symbol: "AAPLc", side: "sideways", amount: "10" },
  });
  expect(response.statusCode).toBe(400);
});

test("quote rejects symbols outside the catalogue", async () => {
  const app = await harness({ assets: [AAPL] });
  const response = await app.inject({
    method: "POST",
    url: "/v1/market/quote",
    payload: { symbol: "TSLAc", side: "buy", amount: "10" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().code).toBe("unknown-asset");
});

test("quote returns the router payload unchanged plus the implied price", async () => {
  const quote = quoteOf();
  const { chain } = reader({ quote: async () => quote });
  const app = await harness({ chain, assets: [AAPL] });
  const response = await app.inject({
    method: "POST",
    url: "/v1/market/quote",
    payload: { symbol: "AAPLc", side: "buy", amount: "10" },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toMatchObject(quote);
  expect(body.symbol).toBe("AAPLc");
  expect(body.decimals).toBe(8);
  expect(body.price).toBe(HEALTHY_PRICE);
  expect(body.deviation_bps).toBe("4.38");
});

test("a sell quote inverts the direction: USDC out over shares in", async () => {
  // 0.05 AAPLc in, 16.004 USDC out => 320.08 USDC/share, exactly the reference.
  const { chain } = reader({
    quote: async () =>
      quoteOf({
        token_in: AAPL.token,
        token_out: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount_in: "5000000",
        amount_out: "16004000",
        min_out: "15923980",
      }),
  });
  const app = await harness({ chain, assets: [AAPL] });
  const body = (
    await app.inject({
      method: "POST",
      url: "/v1/market/quote",
      payload: { symbol: "AAPLc", side: "sell", amount: "0.05" },
    })
  ).json();
  expect(body.price).toBe("320.08");
  expect(body.deviation_bps).toBe("0.00");
});

test("quote refuses to hand back a fill outside the reference band", async () => {
  const { chain } = reader({ quote: async () => quoteOf({ amount_out: "2500000" }) });
  const app = await harness({ chain, assets: [AAPL] });
  const response = await app.inject({
    method: "POST",
    url: "/v1/market/quote",
    payload: { symbol: "AAPLc", side: "buy", amount: "10" },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json().code).toBe("quote-deviation");
  expect(response.json().detail).toContain("2496.88 bps");
});

test("quote refuses a fill it cannot check against a reference", async () => {
  const { chain } = reader({ quote: async () => quoteOf({ reference: "0" }) });
  const app = await harness({ chain, assets: [AAPL] });
  const response = await app.inject({
    method: "POST",
    url: "/v1/market/quote",
    payload: { symbol: "AAPLc", side: "buy", amount: "10" },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json().code).toBe("unavailable");
});

test("impliedPrice guards every divide-by-zero and malformed amount", () => {
  expect(impliedPrice(AAPL, "buy", TEN_USDC, "0")).toBeNull();
  expect(impliedPrice(AAPL, "sell", "0", "16004000")).toBeNull();
  expect(impliedPrice(AAPL, "buy", "10.5", HEALTHY_OUT)).toBeNull();
  expect(impliedPrice(AAPL, "buy", "-10000000", HEALTHY_OUT)).toBeNull();
  expect(impliedPrice(AAPL, "buy", "0x10", HEALTHY_OUT)).toBeNull();
  expect(impliedPrice(AAPL, "buy", TEN_USDC, HEALTHY_OUT)).toBe(HEALTHY_PRICE);
  // 8 decimals, not 18: the same raw output read as an 18-decimal token is 10^10 wrong.
  expect(impliedPrice({ ...AAPL, decimals: 18 }, "buy", TEN_USDC, HEALTHY_OUT)).not.toBe(
    HEALTHY_PRICE,
  );
});

test("deviationBps refuses a non-positive or non-numeric reference", () => {
  expect(deviationBps("320.22", "0")).toBeNull();
  expect(deviationBps("320.22", "-1")).toBeNull();
  expect(deviationBps("320.22", "unavailable")).toBeNull();
  expect(deviationBps("320.22", "320.22")).toBe("0.00");
  expect(deviationBps("320.08", "320.22")).toBe("-4.37");
  // A hair below the reference must not print as negative zero.
  expect(deviationBps("319.9999999999", "320")).toBe("0.00");
});

test("a fill with a zero output is a broken route, not a NaN price", () => {
  const entry = catalogueEntry({
    asset: AAPL,
    feed: oracle("AAPLc", NAV),
    quote: quoteOf({ amount_out: "0" }),
    probe,
  });
  expect(entry.tradable).toBe(false);
  expect(entry.reason).toBe("no-priced-route");
  expect(entry.quote).toBeNull();
  expect(entry.deviation_bps).toBeNull();
  expect(JSON.stringify(entry)).not.toContain("NaN");
});

test("a fill whose own reference is unusable is not tradable", () => {
  const entry = catalogueEntry({
    asset: AAPL,
    feed: oracle("AAPLc", NAV),
    quote: quoteOf({ reference: "0" }),
    probe,
  });
  expect(entry.tradable).toBe(false);
  expect(entry.reason).toBe("reference-unavailable");
  // The oracle NAV is still surfaced; only the quote's own reference was unusable.
  expect(entry.nav).toBe(NAV);
  expect(entry.nav_source).toBe("oracle");
});

test("the deviation limit is enforced on the exact value, not the rounded one", () => {
  // 105.000001 USDC for one whole share against a 100 reference is 500.0001 bps: it prints
  // as "500.00" but is still outside the band, and a check on the rounded string would pass it.
  const entry = catalogueEntry({
    asset: AAPL,
    feed: oracle("AAPLc", "100"),
    quote: quoteOf({ amount_in: "105000001", amount_out: "100000000", reference: "100" }),
    probe,
  });
  expect(entry.quote?.price).toBe("105.000001");
  expect(entry.deviation_bps).toBe("500.00");
  expect(entry.tradable).toBe(false);
  expect(entry.reason).toBe("quote-deviation");
});

test("a fill exactly on the limit is still tradable", () => {
  const entry = catalogueEntry({
    asset: AAPL,
    feed: oracle("AAPLc", "100"),
    quote: quoteOf({ amount_in: "105000000", amount_out: "100000000", reference: "100" }),
    probe,
  });
  expect(entry.deviation_bps).toBe("500.00");
  expect(entry.tradable).toBe(true);
});

test("a zero oracle answer is treated as no reference at all", () => {
  const entry = catalogueEntry({ asset: AAPL, feed: oracle("AAPLc", "0"), quote: null, probe });
  expect(entry.reason).toBe("reference-unavailable");
  expect(entry.nav).toBeNull();
  expect(entry.nav_source).toBeNull();
});

test("a sell-side probe denominates its size in shares, not USDC", async () => {
  const { chain } = reader({ market: async () => [oracle("AAPLc", NAV)] });
  const snapshots = new MarketSnapshots(chain, [AAPL], {
    probe: { side: "sell", amount: "0.05" },
  });
  const snapshot = await snapshots.current();
  expect(snapshot.probe).toMatchObject({ side: "sell", amount: "0.05", slippage_bps: 50 });
  expect(only(snapshot.catalogue).detail).toContain("0.05 AAPLc sell");
});
