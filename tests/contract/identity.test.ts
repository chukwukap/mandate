import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CHAIN_ID } from "../../packages/evm/src/addresses/index.js";
import {
  type ContractApi,
  call,
  newIdentity,
  startContractApi,
  type TestIdentity,
} from "./harness.js";
import {
  healthSchema,
  meSchema,
  parsed,
  problemSchema,
  readySchema,
  walletsSchema,
} from "./schemas.js";

/**
 * `/v1/me`, `/v1/me/wallets`, `/health` and `/ready`.
 *
 * `/v1/me` is the endpoint the whole frontend hangs off: it decides whether the user is signed
 * in, which wallet the rest of the session acts as, whether trading is offered at all, and which
 * chain the client will refuse to sign on. Almost every field is a branch in apps/web, so almost
 * every field is a breaking change to remove.
 *
 * `/health` and `/ready` answer different questions with different consequences and their bodies
 * are pinned separately for that reason — see the comments on each.
 */

let api: ContractApi;
let alice: TestIdentity;

beforeAll(async () => {
  alice = newIdentity();
  api = await startContractApi({ identities: [alice] });
}, 60_000);

afterAll(async () => {
  await api.close();
}, 30_000);

describe("GET /v1/me", () => {
  test("the response validates and describes one resolved wallet", async () => {
    const response = await call(api, { url: "/v1/me", token: alice.token });
    expect(response.statusCode).toBe(200);
    const body = parsed(meSchema, response.json());
    expect(body.privy_did).toBe(alice.privyDid);
    expect(body.wallets).toEqual([alice.wallet]);
    expect(body.wallet).toBe(alice.wallet);
    expect(body.wallet_state).toBe("resolved");
    expect(body.wallet_selection_required).toBe(false);
    // The client refuses to sign on the wrong network rather than producing a signature bound
    // to a chain this API will not execute on, so the chain id is part of the identity answer.
    expect(body.chain_id).toBe(CHAIN_ID);
    expect(body.chain_id).toBe(8453);
    expect(body.automation).toEqual({
      supported: false,
      signer_id: null,
      wallet: null,
      delegated: false,
    });
  });

  test("no session identifier is published, because a 200 does not prove the session is live", async () => {
    const raw = (await call(api, { url: "/v1/me", token: alice.token })).json<
      Record<string, unknown>
    >();
    // Local JWT verification cannot observe a logout or a revocation. A `session_id` field would
    // imply this endpoint knows something it does not, and nothing here may suggest otherwise —
    // there is deliberately no login, logout or nonce route to build a parallel session on.
    expect(raw).not.toHaveProperty("session_id");
    expect(raw).not.toHaveProperty("sessionId");
    // Nor is the bearer token or any Privy claim echoed back.
    expect(JSON.stringify(raw)).not.toContain(alice.token);
  });

  test("the wallet header selects among linked wallets and is never echoed when unknown", async () => {
    const carol = newIdentity({ wallets: 2 });
    const api2 = await startContractApi({ identities: [carol] });
    try {
      const none = parsed(
        meSchema,
        (await call(api2, { url: "/v1/me", token: carol.token })).json(),
      );
      // Two linked wallets and no header: the endpoint describes the ambiguity rather than
      // picking one, so the client can render a picker instead of retrying a doomed request.
      expect(none.wallet).toBeNull();
      expect(none.wallet_state).toBe("selection_required");
      expect(none.wallet_selection_required).toBe(true);

      const chosen = parsed(
        meSchema,
        (
          await call(api2, {
            url: "/v1/me",
            token: carol.token,
            // Checksummed on the way in; Privy stores lowercase. The match is case-insensitive.
            wallet: (carol.wallets[1] as string).toUpperCase().replace("0X", "0x"),
          })
        ).json(),
      );
      expect(chosen.wallet).toBe(carol.wallets[1] as string);
      expect(chosen.wallet_state).toBe("resolved");

      const foreign = parsed(
        meSchema,
        (
          await call(api2, {
            url: "/v1/me",
            token: carol.token,
            wallet: `0x${"ee".repeat(20)}`,
          })
        ).json(),
      );
      // An address that is not in the verified list resolves to null, never to itself. Echoing
      // it back would let a caller plant an address the frontend then sends on every subsequent
      // trading call, and it would look like provenance to a future reader of this response.
      expect(foreign.wallet).toBeNull();
      expect(foreign.wallet_state).toBe("not_linked");
    } finally {
      await api2.close();
    }
  }, 60_000);

  test("eligibility is reported as a class, never as the configured country list", async () => {
    const eligible = parsed(
      meSchema,
      (await call(api, { url: "/v1/me", token: alice.token })).json(),
    );
    expect(eligible.eligible).toBe(true);
    expect(eligible.eligibility_reason).toBeNull();

    const restricted = parsed(
      meSchema,
      (
        await call(api, {
          url: "/v1/me",
          token: alice.token,
          remoteAddress: "127.0.0.1",
          headers: { "cf-ipcountry": "US" },
        })
      ).json(),
    );
    expect(restricted.eligible).toBe(false);
    expect(restricted.jurisdiction).toBe("US");
    // A class, not a policy dump: returning the allowlist would turn a per-user answer into an
    // enumerable map of where the product operates.
    expect(restricted.eligibility_reason).toBe("region_restricted");
    const body = JSON.stringify(restricted);
    expect(body).not.toContain("GB,NG");
    expect(body).not.toContain("eligible_countries");
  });

  test("a country nobody stamped is region_unknown, not region_restricted", async () => {
    const production = await startContractApi({
      identities: [alice],
      // DEV_COUNTRY only applies outside production, so this is how an unplaceable caller looks
      // in the deployed configuration.
      config: { NODE_ENV: "production", APP_ORIGIN: "https://app.example.com" },
    });
    try {
      const body = parsed(
        meSchema,
        (await call(production, { url: "/v1/me", token: alice.token })).json(),
      );
      expect(body.jurisdiction).toBe("XX");
      expect(body.eligible).toBe(false);
      // The user is not barred; we simply cannot place them. Accusing them of being in a
      // restricted market is a different, and wrong, sentence.
      expect(body.eligibility_reason).toBe("region_unknown");
    } finally {
      await production.close();
    }
  }, 60_000);
});

describe("GET /v1/me/wallets", () => {
  test("one row per linked wallet, in the order supplied", async () => {
    const carol = newIdentity({ wallets: 2 });
    const api2 = await startContractApi({ identities: [carol] });
    try {
      const response = await call(api2, { url: "/v1/me/wallets", token: carol.token });
      expect(response.statusCode).toBe(200);
      const body = parsed(walletsSchema, response.json());
      expect(body.items.map((item) => item.address)).toEqual([...carol.wallets]);
      for (const item of body.items) {
        expect(item.embedded).toBe(false);
        expect(item.delegated).toBe(false);
      }
      expect(body.signer_id).toBeNull();
    } finally {
      await api2.close();
    }
  }, 60_000);
});

describe("GET /health and GET /ready", () => {
  test("liveness touches nothing and answers one key", async () => {
    const response = await call(api, { url: "/health" });
    expect(response.statusCode).toBe(200);
    // Strict: a liveness probe that consulted PostgreSQL would fail on every replica at once
    // during one database outage, and the orchestrator would answer by killing all of them.
    parsed(healthSchema, response.json());
  });

  test("readiness is exactly four keys and nothing an unauthorised caller can fingerprint", async () => {
    const response = await call(api, { url: "/ready" });
    expect(response.statusCode).toBe(200);
    const body = parsed(readySchema, response.json());
    expect(body).toEqual({
      status: "ready",
      database: true,
      chain: true,
      execution_available: true,
    });
  });

  test("a database that cannot be reached is 503 with the same four keys", async () => {
    const degraded = await startContractApi({ identities: [alice], databaseReady: false });
    try {
      const response = await call(degraded, { url: "/ready" });
      // 503 so the load balancer routes past this instance instead of handing a user a 500.
      expect(response.statusCode).toBe(503);
      const body = parsed(readySchema, response.json());
      expect(body.status).toBe("unavailable");
      expect(body.database).toBe(false);
    } finally {
      await degraded.close();
    }
  }, 60_000);

  test("a missing worker degrades a flag, it does not fail readiness", async () => {
    const noWorker = await startContractApi({ identities: [alice], workerAvailable: false });
    try {
      const ready = parsed(readySchema, (await call(noWorker, { url: "/ready" })).json());
      // An API instance with no worker behind it still serves every read and still accepts a
      // signed strategy. Failing readiness on the heartbeat would take the API down for a
      // worker deploy.
      expect(ready.status).toBe("ready");
      expect(ready.execution_available).toBe(false);
      const me = parsed(
        meSchema,
        (await call(noWorker, { url: "/v1/me", token: alice.token })).json(),
      );
      // The same fact reaches the client through /v1/me, which is what the UI branches on to
      // stop promising automatic execution.
      expect(me.execution_available).toBe(false);
    } finally {
      await noWorker.close();
    }
  }, 60_000);

  test("both probes are exempt from the rate limiter", async () => {
    // A load balancer polling from one source IP once a second is 60/min per endpoint, and a
    // 429 reads to an orchestrator as "unhealthy" — a rate limiter restarting healthy instances
    // is a self-inflicted outage.
    for (let i = 0; i < 150; i++) {
      const response = await call(api, { url: "/health", remoteAddress: "10.9.9.9" });
      expect(response.statusCode).toBe(200);
    }
  }, 60_000);

  test("neither probe requires a token, and both are no-store", async () => {
    for (const url of ["/health", "/ready"]) {
      const response = await call(api, { url });
      expect(response.statusCode).toBeLessThan(500);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    // /v1/me is not in that set, and asking for it anonymously is the RFC7807 401.
    expect(parsed(problemSchema, (await call(api, { url: "/v1/me" })).json()).status).toBe(401);
  });
});
