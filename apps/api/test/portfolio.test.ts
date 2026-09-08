import { afterEach, expect, test } from "bun:test";
import type { BalanceReader, Hex } from "@mandate/contracts";
import { Problem } from "@mandate/contracts";
import { ASSETS } from "@mandate/evm";
import Fastify, { type FastifyInstance } from "fastify";
import type { Principal } from "../src/modules/auth/principal.js";
import type { MarketSnapshots } from "../src/modules/market/snapshot.js";
import { registerPortfolio } from "../src/modules/portfolio/index.js";

const WALLET = "0x5642a685105000a36de7202d9174ecb8bb503fb5" as Hex;

const opened: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

/**
 * The route with everything around it stubbed to the shape app.ts gives it. The principal is
 * set by an onRequest hook the way the real auth hook does it, so `principal(request)` sees
 * exactly what it would in production.
 */
async function harness(chain: BalanceReader, user: Principal | null) {
  const app = Fastify({ logger: false });
  app.decorateRequest("principal", null);
  app.decorateRequest("jurisdiction", "GB");
  app.decorateRequest("eligible", true);
  app.addHook("onRequest", async (request) => {
    request.principal = user;
  });
  app.setErrorHandler((error, _request, reply) => {
    const problem =
      error instanceof Problem
        ? error
        : new Problem(500, "internal-error", "Internal error", "Unexpected failure.");
    void reply
      .code(problem.status)
      .type("application/problem+json")
      .send({ status: problem.status, code: problem.code, detail: problem.detail });
  });
  // A price failure is already tolerated by the route; rejecting here proves that stays true
  // while the balance path is what is under test.
  const snapshots = {
    current: async () => {
      throw new Error("no snapshot");
    },
  } as unknown as MarketSnapshots;
  await registerPortfolio(app, { chain, assets: ASSETS, snapshots });
  opened.push(app);
  return app;
}

const alice: Principal = {
  privyDid: "did:privy:alice",
  sessionId: "session",
  wallets: [WALLET],
  user: "00000000-0000-0000-0000-000000000001",
};

test("a chain that cannot be reached is reported as unavailable, not as our bug", async () => {
  // This used to escape as a generic 500 "internal-error" — the code an operator reads as "look
  // for a defect in this route" — while the only thing wrong was that the RPC was down. Seen
  // for real when the local fork died under a user: the overview showed "Balances are
  // unavailable right now" and the API log said internal-error.
  const chain = {
    balances: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
    },
  } as unknown as BalanceReader;
  const app = await harness(chain, alice);
  const response = await app.inject({ method: "GET", url: "/v1/portfolio" });
  expect(response.statusCode).toBe(503);
  const body = response.json<{ code: string; detail: string }>();
  expect(body.code).toBe("unavailable");
  expect(body.detail).toMatch(/chain/i);
});

test("no principal is still a 401, ahead of any chain call", async () => {
  let called = false;
  const chain = {
    balances: async () => {
      called = true;
      throw new Error("must not be reached");
    },
  } as unknown as BalanceReader;
  const app = await harness(chain, null);
  const response = await app.inject({ method: "GET", url: "/v1/portfolio" });
  expect(response.statusCode).toBe(401);
  // Authorization decides before the RPC is touched: an anonymous caller must not be able to
  // make this server spend a balance read on their behalf.
  expect(called).toBe(false);
});
