import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { EQUITY_DECIMALS, QUOTE_DECIMALS } from "../../packages/contracts/src/index.js";
import { decimalSchema } from "../../packages/contracts/src/schemas/primitives.js";
import { MAX_VALIDATION_AGE } from "../../packages/evm/src/clients/base.js";
import { MAX_FEED_AGE_SECONDS } from "../../packages/evm/src/feeds/staleness.js";
import { FEED_PATTERN } from "../../packages/strategy/src/evaluation/money.js";
import {
  CATALOGUE,
  type ContractApi,
  call,
  newIdentity,
  startContractApi,
  type TestIdentity,
} from "./harness.js";
import {
  bpsStringSchema,
  fractionDigits,
  marketSchema,
  parsed,
  problemSchema,
  quoteSchema,
} from "./schemas.js";

/**
 * `GET /v1/market` and `POST /v1/market/quote` — the two responses that carry a number a user
 * acts on.
 *
 * The catalogue is the first thing apps/web loads and the only unauthenticated `/v1` path, so
 * every field in it is public API. The invariants asserted here are the ones that have already
 * cost something:
 *
 *  - decimals is 8 for every equity, never 18, and never merely "an integer";
 *  - a published price is a decimal string at USDC precision, not the 78-digit quotient;
 *  - a blocked asset is still listed, with both a reason code and a sentence;
 *  - amounts are integer strings in the token's own smallest unit.
 */

/**
 * The bound `feeds[].value` is held to.
 *
 * Wider than `decimalSchema`, and the gap is real rather than sloppiness. `decimalSchema` caps
 * fraction digits at 28, which is the authored-constant rule — what a human writes in a cap. A
 * feed value is computed, and `FEED_PATTERN` in @mandate/strategy is the rule the evaluator
 * actually applies to one, at 80. The API hands `feeds` through from whatever `ChainReader` it
 * was built with, so this is the only bound the route itself can promise; the tighter USDC
 * quantisation is asserted below on the numbers the API computes for itself.
 *
 * The two readers in this repository disagree on the point today, which is why the wide bound
 * is what a contract test can hold: the shipped `BaseReader.assetMarket` quantises `dex:` to six
 * places before publishing, while the recorded fixture client still emits the raw 10/amount_out
 * quotient at the full 78-digit `Money` precision.
 */
const feedValueSchema = z.string().regex(FEED_PATTERN);

let api: ContractApi;
let alice: TestIdentity;

beforeAll(async () => {
  alice = newIdentity();
  api = await startContractApi({ identities: [alice] });
}, 60_000);

afterAll(async () => {
  await api.close();
}, 30_000);

describe("GET /v1/market", () => {
  test("the whole response validates against the shared schemas", async () => {
    const response = await call(api, { url: "/v1/market" });
    expect(response.statusCode).toBe(200);
    const body = parsed(marketSchema(feedValueSchema), response.json());
    expect(body.chain_id).toBe(8453);
    expect(body.reference_notice).toContain("A quote is not a trade authorization.");
  });

  test("it is the one /v1 path served without a bearer token", async () => {
    // DEFAULT_PUBLIC_PATHS is an exact-path allowlist of exactly this route. Its sibling
    // /v1/market/quote is NOT public: a quote costs RPC calls and is gated on eligibility.
    expect((await call(api, { url: "/v1/market" })).statusCode).toBe(200);
    const quote = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      payload: { symbol: "AAPLc", side: "buy", amount: "10" },
    });
    expect(quote.statusCode).toBe(401);
    expect(parsed(problemSchema, quote.json()).code).toBe("unauthenticated");
  });

  test("every listed equity is 8 decimals, and the catalogue agrees with the asset list", async () => {
    const body = parsed(
      marketSchema(feedValueSchema),
      (await call(api, { url: "/v1/market" })).json(),
    );
    // Not a spot check: assuming 18 misprices an order by 1e10, and the assertion is worth
    // nothing unless it covers every entry the API is willing to hand out.
    for (const asset of body.assets) expect(asset.decimals).toBe(EQUITY_DECIMALS);
    for (const entry of body.catalogue) expect(entry.decimals).toBe(EQUITY_DECIMALS);
    // The two arrays describe the same universe. A catalogue row missing for a listed asset is
    // the failure mode this endpoint exists to prevent, so it is asserted as set equality
    // rather than as a length match.
    expect(body.catalogue.map((entry) => entry.symbol)).toEqual(
      CATALOGUE.map((asset) => asset.symbol),
    );
    expect(body.assets.map((asset) => asset.token)).toEqual(CATALOGUE.map((asset) => asset.token));
  });

  test("an asset that cannot be traded is listed with a reason AND a detail, never omitted", async () => {
    const body = parsed(
      marketSchema(feedValueSchema),
      (await call(api, { url: "/v1/market" })).json(),
    );
    const blocked = body.catalogue.filter((entry) => !entry.tradable);
    // MSFTc has a live Chainlink reference and no Aerodrome route at any tick spacing. It is
    // the concrete case: a silently missing symbol is indistinguishable from one that was never
    // configured, and a reason code with no sentence sends the reader to the wrong subsystem —
    // which is what happened when this was reported as reference-stale.
    expect(blocked.map((entry) => entry.symbol)).toContain("MSFTc");
    for (const entry of blocked) {
      expect(entry.reason).not.toBeNull();
      expect(entry.detail).not.toBeNull();
      expect((entry.detail ?? "").length).toBeGreaterThan(10);
    }
    const msft = blocked.find((entry) => entry.symbol === "MSFTc");
    expect(msft?.reason).toBe("no-priced-route");
    // The blocker names liquidity, not the reference, and the reference is still published so a
    // reader can see it was fine.
    expect(msft?.detail).toContain("No Aerodrome pool");
    expect(msft?.nav).not.toBeNull();
    expect(msft?.nav_source).toBe("oracle");
    // A tradable row carries neither, and that is the same invariant read the other way.
    for (const entry of body.catalogue.filter((e) => e.tradable)) {
      expect(entry.reason).toBeNull();
      expect(entry.detail).toBeNull();
      expect(entry.quote).not.toBeNull();
    }
  });

  test("published prices are decimal strings at USDC precision, never the 78-digit quotient", async () => {
    const body = parsed(
      marketSchema(feedValueSchema),
      (await call(api, { url: "/v1/market" })).json(),
    );
    for (const entry of body.catalogue) {
      if (!entry.quote) continue;
      // `catalogueEntrySchema` already refuses anything but `^\d{1,30}(\.\d{1,6})?$` here. The
      // explicit digit count is the readable form of the same rule: an unrounded division emits
      // 321.3276745387662559670549161848893733082097935533956623334558662865574495322, which is
      // not a price anyone can settle at and which a consumer parsing it as a float truncates.
      expect(fractionDigits(entry.quote.price)).toBeLessThanOrEqual(QUOTE_DECIMALS);
      expect(entry.quote.price.replace(/\D/g, "").length).toBeLessThan(40);
      // Deviation is two places, always, and never negative zero.
      parsed(bpsStringSchema, entry.deviation_bps);
    }
  });

  test("amounts are integer strings in the token's own smallest unit", async () => {
    const body = parsed(
      marketSchema(feedValueSchema),
      (await call(api, { url: "/v1/market" })).json(),
    );
    for (const entry of body.catalogue) {
      if (!entry.quote) continue;
      // `rawUnitsSchema` in the response schema forbids leading zeros as well as decimals: the
      // worker compares this string against units(...).toString() by exact equality before it
      // will sign, so "0100" and "100" are the same number but not the same authorization.
      for (const raw of [entry.quote.amount_in, entry.quote.amount_out, entry.quote.min_out])
        expect(raw).toMatch(/^(?:0|[1-9]\d*)$/);
      // The floor is below the expected output by construction; a min_out at or above it would
      // mean the slippage tolerance was applied in the wrong direction.
      expect(BigInt(entry.quote.min_out)).toBeLessThan(BigInt(entry.quote.amount_out));
      expect(BigInt(entry.quote.amount_in)).toBeGreaterThan(0n);
    }
  });

  test("every feed reading carries a uri, an age and a staleness verdict", async () => {
    const body = parsed(
      marketSchema(feedValueSchema),
      (await call(api, { url: "/v1/market" })).json(),
    );
    // Two independent observations per asset. The prefix is what distinguishes them, and
    // confusing them is how a venue price ends up validated against itself.
    for (const asset of CATALOGUE) {
      const oracle = body.feeds.find((feed) => feed.uri === `oracle:${asset.symbol}`);
      expect(oracle).toBeDefined();
      expect(body.feeds.some((feed) => feed.uri === `dex:${asset.symbol}`)).toBe(true);
      // A Chainlink answer is an 8-decimal integer scaled down, so it is inside the authored
      // 28-place bound even though a computed venue price need not be.
      if (oracle?.value !== null && oracle?.value !== undefined) {
        parsed(decimalSchema, oracle.value);
        expect(fractionDigits(oracle.value)).toBeLessThanOrEqual(EQUITY_DECIMALS);
      }
    }
    // An absent reading is `{ value: null, updated_at: 0, stale: true }`, never a missing entry
    // and never a zero price: "we cannot price this" must not read as "this is worthless".
    for (const feed of body.feeds)
      if (feed.value === null) {
        expect(feed.updated_at).toBe(0);
        expect(feed.stale).toBe(true);
      }
  });

  test("staleness and validation are two different bounds, and the response reflects both", async () => {
    // 26h answers "is this a live price" and drives `stale`; 96h answers "can this still anchor
    // a deviation check". These feeds have no heartbeat off-hours and hold the last close, so on
    // a weekend every symbol is 37-43h old while its pool trades normally. Collapsing the two
    // switched the whole market off two days in seven.
    expect(MAX_FEED_AGE_SECONDS).toBe(26 * 3600);
    expect(MAX_VALIDATION_AGE).toBe(96 * 3600);
    expect(MAX_VALIDATION_AGE).toBeGreaterThan(MAX_FEED_AGE_SECONDS);
    const body = parsed(
      marketSchema(feedValueSchema),
      (await call(api, { url: "/v1/market" })).json(),
    );
    // A row that produced a fill reports the reference the fill was admitted against, and that
    // reference is not stale by construction — reporting the cached oracle's staleness beside a
    // verdict just made from a fresher reading would contradict it.
    for (const entry of body.catalogue.filter((e) => e.tradable)) {
      expect(entry.nav_source).toBe("quote");
      expect(entry.nav_stale).toBe(false);
    }
    // `reference-stale` is only ever reachable past the validation bound, not past `stale`.
    expect(body.catalogue.some((entry) => entry.reason === "reference-stale")).toBe(false);
  });

  test("the probe terms are declared, so a reader knows what tradable was measured with", async () => {
    const body = parsed(
      marketSchema(feedValueSchema),
      (await call(api, { url: "/v1/market" })).json(),
    );
    expect(body.probe.side).toBe("buy");
    expect(body.probe.amount).toBe("10");
    // The band the venue itself enforces, restated in the response rather than left implicit:
    // the measured tick-spacing-200 AAPLc pool quotes $37,861 against a $320 NAV, 11,729% out.
    expect(body.probe.deviation_limit_bps).toBe(500);
    expect(body.probe.note).toContain("does not measure depth at larger sizes");
  });
});

describe("POST /v1/market/quote", () => {
  test("the response validates and carries the asset's own scale", async () => {
    const response = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      token: alice.token,
      payload: { symbol: "AAPLc", side: "buy", amount: "10" },
    });
    expect(response.statusCode).toBe(200);
    const body = parsed(quoteSchema, response.json());
    expect(body.decimals).toBe(EQUITY_DECIMALS);
    expect(body.symbol).toBe("AAPLc");
    // A buy spends USDC and receives the equity, so amount_in is at 6 decimals: 10 USDC is
    // 10000000, not 10000000000000000000.
    expect(body.amount_in).toBe("10000000");
    expect(fractionDigits(body.price)).toBeLessThanOrEqual(QUOTE_DECIMALS);
    expect(BigInt(body.min_out)).toBeLessThan(BigInt(body.amount_out));
  });

  test("an unknown symbol is a 400 problem, not an empty quote", async () => {
    const response = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      token: alice.token,
      payload: { symbol: "NOTREAL", side: "buy", amount: "10" },
    });
    expect(response.statusCode).toBe(400);
    expect(parsed(problemSchema, response.json()).code).toBe("unknown-asset");
  });

  test("an asset with no route answers 503 quote-deviation-or-unavailable, never a price", async () => {
    const response = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      token: alice.token,
      payload: { symbol: "MSFTc", side: "buy", amount: "10" },
    });
    // The router refuses before a price can be composed. The status is what matters to a
    // client: 503 is "retry", and inventing a 200 with a null price would be rendered.
    expect(response.statusCode).toBe(503);
    const problem = parsed(problemSchema, response.json());
    expect(["unavailable", "quote-deviation"]).toContain(problem.code);
  });

  test("a malformed body is rejected by the route schema before any catalogue lookup", async () => {
    // A JSON number where a decimal string belongs. Accepting it would put a float in the path
    // of a spend cap: 100.000001 USDC is exact as a string and is not representable as float64.
    const response = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      token: alice.token,
      payload: { symbol: "AAPLc", side: "buy", amount: 10 },
    });
    expect(response.statusCode).toBe(400);
    expect(parsed(problemSchema, response.json()).code).toBe("invalid-request");
  });

  test("slippage beyond the 500 bps reference band is refused at the edge", async () => {
    const response = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      token: alice.token,
      payload: { symbol: "AAPLc", side: "buy", amount: "10", slippage_bps: 501 },
    });
    // packages/evm refuses any route more than 5% from the Chainlink reference, so a larger
    // tolerance is silently unusable rather than merely risky.
    expect(response.statusCode).toBe(400);
    expect(parsed(problemSchema, response.json()).code).toBe("invalid-request");
  });
});
