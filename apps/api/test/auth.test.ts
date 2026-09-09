import { afterEach, describe, expect, test } from "bun:test";
import rateLimit from "@fastify/rate-limit";
import { type EmbeddedWallet, eligible, jurisdiction, selectWallet } from "@mandate/auth";
import { type Config, loadConfig } from "@mandate/config";
import { type Hex, Problem } from "@mandate/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import {
  type AuthDependencies,
  eligibilityReason,
  registerAuth,
  walletSelection,
} from "../src/modules/auth/index.js";
import { automationOf, type WalletReader } from "../src/modules/automation/index.js";

const alice = "0x1111111111111111111111111111111111111111" as Hex;
const bob = "0x2222222222222222222222222222222222222222" as Hex;
const mallory = "0x3333333333333333333333333333333333333333" as Hex;
const SIGNER = "kq_test_signer";

function settings(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://local:local@localhost/test",
    PRIVY_APP_ID: "test",
    PRIVY_APP_SECRET: "secret",
    LOG_LEVEL: "silent",
    ELIGIBLE_COUNTRIES: "GB",
    ...overrides,
  });
}

type FakeWallets = WalletReader & { calls: string[] };
/**
 * Privy's linked-accounts read, reduced to the one fact this module asks for. `embedded` lists
 * the addresses that are embedded wallets; `delegated` the subset delegated to the app.
 */
function walletReader(
  options: { embedded?: Hex[]; delegated?: Hex[]; fail?: boolean } = {},
): FakeWallets {
  const calls: string[] = [];
  const embedded = new Set((options.embedded ?? []).map((a) => a.toLowerCase()));
  const delegated = new Set((options.delegated ?? []).map((a) => a.toLowerCase()));
  return {
    calls,
    embedded: async (_did, address): Promise<EmbeddedWallet | null> => {
      calls.push(address);
      if (options.fail) throw new Error("privy: 503 https://auth.privy.io/api/v1/users/secret");
      const key = address.toLowerCase();
      if (!embedded.has(key) && !delegated.has(key)) return null;
      return {
        id: `wallet-${key.slice(2, 6)}`,
        address: key as Hex,
        delegated: delegated.has(key),
      };
    },
  };
}

const opened: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

/**
 * Reproduces the parts of buildApp this module depends on — the request decorators, the
 * jurisdiction/eligibility hook and the problem+json error handler — without booting the real app.
 * That keeps this suite free of PGlite and network access.
 */
async function harness(
  options: {
    wallets?: Hex[];
    config?: Config;
    deps?: AuthDependencies;
    globalRateLimit?: number;
  } = {},
) {
  const config = options.config ?? settings();
  const wallets = options.wallets ?? [alice];
  const app = Fastify({ logger: false, requestIdHeader: false, trustProxy: false });
  app.decorateRequest("principal", null);
  app.decorateRequest("jurisdiction", "XX");
  app.decorateRequest("eligible", false);
  await app.register(rateLimit, { max: options.globalRateLimit ?? 1000, timeWindow: "1 minute" });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as Error & { statusCode?: number };
    const problem =
      error instanceof Problem
        ? error
        : failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500
          ? new Problem(
              failure.statusCode,
              "request-rejected",
              "Request rejected",
              "Check the request format or retry later.",
            )
          : new Problem(
              500,
              "internal-error",
              "Unexpected error",
              "The request could not be completed.",
            );
    void reply
      .code(problem.status)
      .type("application/problem+json")
      .send({
        type: `urn:mandate:problem:${problem.code}`,
        title: problem.title,
        status: problem.status,
        code: problem.code,
        detail: problem.detail,
        request_id: request.id,
      });
  });
  app.addHook("onRequest", async (request) => {
    request.jurisdiction = jurisdiction({
      remoteIp: request.ip,
      countryHeader:
        typeof request.headers["cf-ipcountry"] === "string"
          ? request.headers["cf-ipcountry"]
          : undefined,
      trustedProxyIps: config.trustedProxyIps,
      devCountry: config.devCountry,
      production: config.env === "production",
    });
    request.eligible = eligible(request.jurisdiction, config.eligibleCountries);
    // The real hook throws Problem.unauthenticated() here. Leaving the principal null instead
    // exercises the module's own fail-closed guard, which is what protects the endpoint if the
    // route is ever moved outside the authenticated /v1/ prefix.
    if (request.headers.authorization !== "Bearer valid") return;
    request.principal = {
      privyDid: "did:privy:alice",
      sessionId: "session-1",
      wallets,
      user: "local-user",
    };
  });
  await registerAuth(app, config, options.deps ?? {});
  await app.ready();
  opened.push(app);
  return app;
}
const signedIn = (headers: Record<string, string> = {}) => ({
  authorization: "Bearer valid",
  ...headers,
});

describe("GET /v1/me", () => {
  test("refuses to describe an identity it has not authenticated", async () => {
    const app = await harness();
    const response = await app.inject({ url: "/v1/me" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status: 401, code: "unauthenticated" });
  });

  test("returns the identity the client needs, and nothing else", async () => {
    const app = await harness();
    const response = await app.inject({ url: "/v1/me", headers: signedIn() });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      user: "local-user",
      privy_did: "did:privy:alice",
      wallets: [alice],
      wallet: alice,
      wallet_state: "resolved",
      wallet_selection_required: false,
      jurisdiction: "XX",
      eligible: false,
      eligibility_reason: "region_unknown",
      chain_id: 8453,
      automation: { supported: false, signer_id: null, wallet: null, delegated: false },
      execution_available: false,
    });
    expect(Date.parse(String(body.server_time))).toBeGreaterThan(0);
    // Pinning the key set is how the session id stays out: a 200 proves the token verified, not
    // that the Privy session is still live, so nothing session-shaped may be published here.
    expect(Object.keys(body).sort()).toEqual([
      "automation",
      "chain_id",
      "eligibility_reason",
      "eligible",
      "execution_available",
      "jurisdiction",
      "privy_did",
      "server_time",
      "user",
      "wallet",
      "wallet_selection_required",
      "wallet_state",
      "wallets",
    ]);
    expect(response.body).not.toContain("session-1");
  });

  test("ignores a country header from an untrusted client", async () => {
    const app = await harness();
    const response = await app.inject({
      url: "/v1/me",
      headers: signedIn({ "cf-ipcountry": "GB" }),
      remoteAddress: "127.0.0.1",
    });
    expect(response.json()).toMatchObject({
      jurisdiction: "XX",
      eligible: false,
      eligibility_reason: "region_unknown",
    });
  });

  test("honours a country stamped by the configured proxy", async () => {
    const app = await harness({ config: settings({ TRUSTED_PROXY_IPS: "127.0.0.1" }) });
    const response = await app.inject({
      url: "/v1/me",
      headers: signedIn({ "cf-ipcountry": "GB" }),
      remoteAddress: "127.0.0.1",
    });
    expect(response.json()).toMatchObject({
      jurisdiction: "GB",
      eligible: true,
      eligibility_reason: null,
    });
  });

  test("classifies an ineligible region without publishing the allowlist", async () => {
    const app = await harness({ config: settings({ TRUSTED_PROXY_IPS: "127.0.0.1" }) });
    const restricted = await app.inject({
      url: "/v1/me",
      headers: signedIn({ "cf-ipcountry": "US" }),
      remoteAddress: "127.0.0.1",
    });
    expect(restricted.json()).toMatchObject({
      jurisdiction: "US",
      eligible: false,
      eligibility_reason: "region_restricted",
    });
    expect(restricted.body).not.toContain("GB");
    const unsupported = await app.inject({
      url: "/v1/me",
      headers: signedIn({ "cf-ipcountry": "FR" }),
      remoteAddress: "127.0.0.1",
    });
    expect(unsupported.json()).toMatchObject({
      eligible: false,
      eligibility_reason: "region_unsupported",
    });
  });

  test("never treats a request-supplied address as a linked wallet", async () => {
    const app = await harness({ wallets: [alice] });
    const response = await app.inject({
      url: `/v1/me?wallet=${mallory}&wallets[]=${mallory}`,
      headers: signedIn({ "x-mandate-wallet": mallory }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      wallets: [alice],
      wallet: null,
      wallet_state: "not_linked",
      wallet_selection_required: false,
    });
    // The unlinked address must not be echoed anywhere: an echo reads as provenance to the next
    // reader and would be sent back on every subsequent trading call.
    expect(response.body.toLowerCase()).not.toContain(mallory.slice(2));
    // There is no route on which a body could supply an address in the first place.
    expect(
      (await app.inject({ method: "POST", url: "/v1/me", headers: signedIn() })).statusCode,
    ).toBe(404);
  });

  test("honours the wallet header only for a linked wallet, regardless of checksum casing", async () => {
    const app = await harness({ wallets: [alice, bob] });
    const response = await app.inject({
      url: "/v1/me",
      headers: signedIn({ "x-mandate-wallet": bob.toUpperCase().replace("0X", "0x") }),
    });
    expect(response.json()).toMatchObject({ wallet: bob, wallet_state: "resolved" });
  });

  test("reports multi-wallet ambiguity instead of failing the request", async () => {
    const app = await harness({ wallets: [alice, bob] });
    const response = await app.inject({ url: "/v1/me", headers: signedIn() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      wallets: [alice, bob],
      wallet: null,
      wallet_state: "selection_required",
      wallet_selection_required: true,
    });
  });

  test("distinguishes a user with no linked wallet from an ambiguous one", async () => {
    const app = await harness({ wallets: [] });
    const response = await app.inject({ url: "/v1/me", headers: signedIn() });
    expect(response.json()).toMatchObject({
      wallets: [],
      wallet: null,
      wallet_state: "none_linked",
      wallet_selection_required: false,
    });
  });

  test("stays available when the worker heartbeat query fails", async () => {
    const app = await harness({
      deps: {
        workerAvailable: async () => {
          throw new Error("password=secret connection refused");
        },
      },
    });
    const response = await app.inject({ url: "/v1/me", headers: signedIn() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ execution_available: false });
    expect(response.body).not.toContain("password");
  });

  test("reports the signer and the selected wallet's delegation, read from Privy", async () => {
    const wallets = walletReader({ delegated: [alice] });
    const app = await harness({
      config: settings({ PRIVY_KEY_QUORUM_ID: SIGNER }),
      deps: { wallets, workerAvailable: async () => true },
    });
    expect(
      await app.inject({ url: "/v1/me", headers: signedIn() }).then((r) => r.json()),
    ).toMatchObject({
      automation: { supported: true, signer_id: SIGNER, wallet: alice, delegated: true },
      execution_available: true,
    });
    expect(wallets.calls).toEqual([alice]);
  });

  test("an embedded wallet that is not delegated is named, an external wallet is not", async () => {
    const wallets = walletReader({ embedded: [alice] });
    const app = await harness({
      wallets: [alice, bob],
      config: settings({ PRIVY_KEY_QUORUM_ID: SIGNER }),
      deps: { wallets },
    });
    const embedded = await app.inject({
      url: "/v1/me",
      headers: signedIn({ "x-mandate-wallet": alice }),
    });
    expect(embedded.json()).toMatchObject({
      automation: { supported: true, wallet: alice, delegated: false },
    });
    // Bob is a linked external wallet: Privy has no embedded wallet at that address, so there
    // is nothing that could ever be delegated and `wallet` says so by staying null.
    const external = await app.inject({
      url: "/v1/me",
      headers: signedIn({ "x-mandate-wallet": bob }),
    });
    expect(external.json()).toMatchObject({
      automation: { supported: true, wallet: null, delegated: false },
    });
  });

  test("asks Privy only when a wallet is selected", async () => {
    const wallets = walletReader({ delegated: [alice, bob] });
    const app = await harness({ wallets: [alice, bob], deps: { wallets } });
    const ambiguous = await app.inject({ url: "/v1/me", headers: signedIn() });
    expect(ambiguous.statusCode).toBe(200);
    expect(ambiguous.json()).toMatchObject({
      wallet_state: "selection_required",
      automation: { wallet: null, delegated: false },
    });
    expect(wallets.calls).toEqual([]);
  });

  test("a Privy failure degrades delegation to false rather than failing identity", async () => {
    const wallets = walletReader({ fail: true });
    const app = await harness({ config: settings({ PRIVY_KEY_QUORUM_ID: SIGNER }), deps: { wallets } });
    const response = await app.inject({ url: "/v1/me", headers: signedIn() });
    // The frontend decides whether the user is signed in from this endpoint. A Privy blip must
    // withhold an offer, not sign everyone out.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      automation: { supported: true, signer_id: SIGNER, wallet: null, delegated: false },
    });
    expect(response.body).not.toContain("privy.io");
  });
});

describe("automationOf", () => {
  test("never rejects, and reports support from configuration alone", async () => {
    const config = settings({ PRIVY_KEY_QUORUM_ID: SIGNER });
    expect(await automationOf(config, undefined, "did", alice)).toEqual({
      supported: true,
      signer_id: SIGNER,
      wallet: null,
      delegated: false,
    });
    expect(
      await automationOf(settings(), walletReader({ delegated: [alice] }), "did", alice),
    ).toEqual({ supported: false, signer_id: null, wallet: alice, delegated: true });
    expect(await automationOf(config, walletReader({ fail: true }), "did", alice)).toMatchObject({
      delegated: false,
    });
  });
});

describe("walletSelection", () => {
  test("agrees with selectWallet on every input the header can produce", () => {
    const cases: Array<{ wallets: Hex[]; requested?: string }> = [
      { wallets: [] },
      { wallets: [], requested: alice },
      { wallets: [alice] },
      { wallets: [alice], requested: "" },
      { wallets: [alice], requested: alice },
      { wallets: [alice], requested: alice.toUpperCase().replace("0X", "0x") },
      { wallets: [alice], requested: bob },
      { wallets: [alice, bob] },
      { wallets: [alice, bob], requested: bob },
      { wallets: [alice, bob], requested: mallory },
      { wallets: [alice], requested: "not-an-address" },
    ];
    for (const input of cases) {
      const selection = walletSelection({ wallets: input.wallets }, input.requested);
      const user = { privyDid: "did:privy:alice", sessionId: "s", wallets: input.wallets };
      let resolved: Hex | null = null;
      let thrown: Problem | null = null;
      try {
        resolved = selectWallet(user, input.requested);
      } catch (error) {
        thrown = error as Problem;
      }
      if (selection.state === "resolved") {
        expect(thrown).toBeNull();
        expect(resolved).toBe(selection.wallet as Hex);
      } else {
        expect(resolved).toBeNull();
        // not_linked is selectWallet's 403; both empty and ambiguous lists are its 409.
        expect(thrown?.status).toBe(selection.state === "not_linked" ? 403 : 409);
      }
    }
  });
});

describe("eligibilityReason", () => {
  test("classifies each ineligible case and stays silent when eligible", () => {
    expect(eligibilityReason("GB", true)).toBeNull();
    expect(eligibilityReason("XX", false)).toBe("region_unknown");
    expect(eligibilityReason("US", false)).toBe("region_restricted");
    expect(eligibilityReason("FR", false)).toBe("region_unsupported");
    // eligible() can never return true for US or XX; if it somehow did, no reason is reported.
    expect(eligibilityReason("US", true)).toBeNull();
  });
});

describe("GET /v1/me/wallets", () => {
  test("reports each linked wallet's embedded and delegated state, in order", async () => {
    const wallets = walletReader({ embedded: [bob], delegated: [alice] });
    const app = await harness({
      wallets: [alice, bob, mallory],
      config: settings({ PRIVY_KEY_QUORUM_ID: SIGNER }),
      deps: { wallets },
    });
    const response = await app.inject({ url: "/v1/me/wallets", headers: signedIn() });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: Array<Record<string, unknown>>;
      chain_id: number;
      signer_id: string;
    }>();
    expect(body.items).toEqual([
      { address: alice, embedded: true, delegated: true },
      { address: bob, embedded: true, delegated: false },
      // An external wallet the user linked: never embedded, never delegable.
      { address: mallory, embedded: false, delegated: false },
    ]);
    expect(body.chain_id).toBe(8453);
    expect(body.signer_id).toBe(SIGNER);
  });

  test("requires authentication", async () => {
    const app = await harness({ deps: { wallets: walletReader() } });
    expect((await app.inject({ url: "/v1/me/wallets" })).statusCode).toBe(401);
  });

  test("answers 503 rather than inventing a delegation when no reader is injected", async () => {
    const app = await harness();
    const response = await app.inject({ url: "/v1/me/wallets", headers: signedIn() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "unavailable", status: 503 });
  });

  test("degrades a row instead of leaking the upstream error", async () => {
    const app = await harness({
      wallets: [alice],
      deps: { wallets: walletReader({ fail: true }) },
    });
    const response = await app.inject({ url: "/v1/me/wallets", headers: signedIn() });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Array<Record<string, unknown>> }>().items[0]).toEqual({
      address: alice,
      embedded: false,
      delegated: false,
    });
    expect(response.body).not.toContain("privy.io");
  });

  test("applies a stricter per-route rate limit than the global limit", async () => {
    const app = await harness({
      wallets: [alice],
      deps: { wallets: walletReader() },
      globalRateLimit: 1000,
    });
    const codes: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      codes.push((await app.inject({ url: "/v1/me/wallets", headers: signedIn() })).statusCode);
    }
    expect(codes.slice(0, 20).every((code) => code === 200)).toBe(true);
    expect(codes[20]).toBe(429);
    // The global limit is untouched, so identity still resolves after the wallet route trips.
    expect((await app.inject({ url: "/v1/me", headers: signedIn() })).statusCode).toBe(200);
  });
});
