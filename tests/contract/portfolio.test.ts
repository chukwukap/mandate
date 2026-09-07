import { afterAll, beforeAll, expect, test } from "bun:test";
import { B20_ASSETS, USDC } from "../fixtures/chain/index.js";
import {
  call,
  type ContractApi,
  newIdentity,
  startContractApi,
  type TestIdentity,
} from "./harness.js";

/**
 * GET /v1/portfolio — what a wallet holds, priced.
 *
 * The property worth pinning is not "it returns JSON". It is that the numbers agree with the
 * chain and with the market page, that a total is never a partial sum wearing a total's name,
 * and that one user cannot read another's holdings by naming their address.
 */

let api: ContractApi;
let alice: TestIdentity;
let mallory: TestIdentity;

const AAPL = B20_ASSETS.find((asset) => asset.symbol === "AAPLc");
if (!AAPL) throw new Error("AAPLc missing from the fixture catalogue");

beforeAll(async () => {
  alice = newIdentity();
  mallory = newIdentity();
  api = await startContractApi({ identities: [alice, mallory] });
  // Alice holds cash and one position; Mallory holds nothing. Both cases are real states a
  // user reaches, and the empty one is the state every new user starts in.
  api.chain.credit(alice.wallet, USDC, "2500");
  api.chain.credit(alice.wallet, AAPL.token, "5");
}, 60_000);

afterAll(async () => {
  await api?.close();
});

test("a wallet's holdings are reported at the same prices the market page quotes", async () => {
  const response = await call(api, {
    url: "/v1/portfolio",
    token: alice.token,
    wallet: alice.wallet,
  });
  expect(response.statusCode).toBe(200);

  const body = response.json<{
    chain_id: number;
    wallet: string;
    cash: string;
    equity: string | null;
    unpriced: string[];
    holdings: { symbol: string; quantity: string; price: string | null; value: string | null }[];
  }>();

  expect(body.chain_id).toBe(8453);
  expect(body.wallet.toLowerCase()).toBe(alice.wallet.toLowerCase());
  expect(body.cash).toBe("2500");

  const aapl = body.holdings.find((holding) => holding.symbol === "AAPLc");
  expect(aapl).toBeTruthy();
  expect(aapl?.quantity).toBe("5");

  // The price must be the one /v1/market publishes for the same asset. Two surfaces quoting one
  // asset at two prices is the bug this endpoint's shared snapshot exists to prevent, and it is
  // invisible unless something compares them.
  const market = await call(api, { url: "/v1/market" });
  expect(market.statusCode).toBe(200);
  const feed = market
    .json<{ assets: { symbol: string }[]; feeds: { uri: string; value: string | null }[] }>()
    .feeds.find((entry) => entry.uri === "oracle:AAPLc");
  expect(aapl?.price).toBe(feed?.value ?? null);

  // And the value has to be the product, not an approximation of it.
  if (aapl?.price) {
    expect(aapl.value).toBe((Number(aapl.quantity) * Number(aapl.price)).toFixed(2));
  }

  // Zero balances are omitted, so a catalogue of eight assets does not become eight rows of
  // 0.00 with one real holding lost among them.
  expect(body.holdings.every((holding) => Number(holding.quantity) > 0)).toBe(true);
});

test("a wallet holding nothing reports zero rather than failing", async () => {
  const response = await call(api, {
    url: "/v1/portfolio",
    token: mallory.token,
    wallet: mallory.wallet,
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ cash: string; holdings: unknown[]; equity: string | null }>();
  expect(body.holdings).toHaveLength(0);
  expect(Number(body.cash)).toBe(0);
  // An empty portfolio still has a total, and that total is zero. Returning null here would put
  // "unavailable" on a screen for a user whose account is simply new.
  expect(body.equity).toBe("0.00");
});

test("a wallet that is not yours is refused, even though the balance is public", async () => {
  // The data is on a public chain; anyone can read it. What must not happen is this API serving
  // it under Mallory's session, labelled as Mallory's portfolio.
  const response = await call(api, {
    url: `/v1/portfolio?wallet=${alice.wallet}`,
    token: mallory.token,
    wallet: mallory.wallet,
  });
  expect(response.statusCode).toBe(403);
  expect(response.json<{ code: string }>().code).toBe("wallet-not-linked");
});

test("a malformed wallet is a 400 with the documented problem shape, not a 500", async () => {
  // `invalid-request`, not a code of this route's own: the querystring schema is registered with
  // the route, so Fastify rejects the value before the handler runs and the caller gets the same
  // problem shape every other endpoint produces for bad input. The handler's own safeParse stays
  // as the type narrowing it also performs, and as the answer if that schema is ever dropped.
  const response = await call(api, {
    url: "/v1/portfolio?wallet=not-an-address",
    token: alice.token,
    wallet: alice.wallet,
  });
  expect(response.statusCode).toBe(400);
  const problem = response.json<{ type: string; status: number; code: string }>();
  expect(problem.status).toBe(400);
  expect(problem.code).toBe("invalid-request");
  expect(problem.type).toMatch(/^urn:mandate:problem:/);
});

test("the endpoint is not public", async () => {
  expect((await call(api, { url: "/v1/portfolio" })).statusCode).toBe(401);
});
