import { afterEach, describe, expect, test } from "bun:test";
import rateLimit from "@fastify/rate-limit";
import { eligible, jurisdiction, selectWallet } from "@mandate/auth";
import { type Config, loadConfig } from "@mandate/config";
import { type ChainReader, type Hex, Problem } from "@mandate/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import {
  type AuthDependencies,
  eligibilityReason,
  registerAuth,
  WalletCapabilities,
  type WalletKind,
  walletSelection,
} from "../src/modules/auth/index.js";

const alice = "0x1111111111111111111111111111111111111111" as Hex;
const bob = "0x2222222222222222222222222222222222222222" as Hex;
const mallory = "0x3333333333333333333333333333333333333333" as Hex;

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

type FakeChain = ChainReader & { calls: Hex[] };
function chainReader(respond: (address: Hex) => Promise<WalletKind>): FakeChain {
  const calls: Hex[] = [];
  return {
    calls,
    ready: async () => true,
    market: async () => [],
    quote: async () => {
      throw Problem.unavailable("No route");
    },
    walletKind: async (address) => {
      calls.push(address);
      return respond(address);
    },
    permissionStatus: async () => ({ approved: false, revoked: false }),
    verifyMessage: async () => false,
    verifyPermission: async () => false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const opened: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

/**
 * Reproduces the parts of buildApp this module depends on — the request decorators, the
 * jurisdiction/eligibility hook and the problem+json error handler — without booting the real app.
 * That keeps this suite free of PGlite and network access, and, until app.ts drops its inline
 * /v1/me, avoids the duplicate-route boot failure that registering the module there would cause.
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

  test("returns the inline handler's fields plus identity the client needs, and nothing else", async () => {
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
      automation_supported: false,
      execution_available: false,
    });
    expect(Date.parse(String(body.server_time))).toBeGreaterThan(0);
    // Pinning the key set is how the session id stays out: a 200 proves the token verified, not
    // that the Privy session is still live, so nothing session-shaped may be published here.
    expect(Object.keys(body).sort()).toEqual([
      "automation_supported",
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

  test("resolves identity without touching the chain", async () => {
    const chain = chainReader(async () => "base_account");
    const app = await harness({ wallets: [alice, bob], deps: { chain } });
    expect((await app.inject({ url: "/v1/me", headers: signedIn() })).statusCode).toBe(200);
    expect(chain.calls).toEqual([]);
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

  test("reports automation support from the configured spender address", async () => {
    const app = await harness({
      config: settings({ SPENDER_ADDRESS: "0x4444444444444444444444444444444444444444" }),
      deps: { workerAvailable: async () => true },
    });
    expect(
      await app.inject({ url: "/v1/me", headers: signedIn() }).then((r) => r.json()),
    ).toMatchObject({ automation_supported: true, execution_available: true });
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

describe("WalletCapabilities", () => {
  const kinds: Record<string, WalletKind> = {
    [alice]: "base_account",
    [bob]: "eoa",
    [mallory]: "contract",
  };
  test("grants spending capability only to a Base account", async () => {
    const chain = chainReader(async (address) => kinds[address] ?? "contract");
    const capabilities = new WalletCapabilities(chain);
    const rows = await capabilities.kinds([alice, bob, mallory], 1_700_000_000_000);
    expect(rows.map((row) => [row.kind, row.can_authorize_spending, row.checked])).toEqual([
      ["base_account", true, true],
      ["eoa", false, true],
      ["contract", false, true],
    ]);
    expect(rows[0]?.checked_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(rows.map((row) => row.address)).toEqual([alice, bob, mallory]);
  });

  test("serves repeat reads from cache and refreshes once the TTL passes", async () => {
    const chain = chainReader(async () => "base_account");
    const capabilities = new WalletCapabilities(chain, 60_000);
    await capabilities.kinds([alice], 0);
    await capabilities.kinds([alice], 59_999);
    expect(chain.calls).toEqual([alice]);
    const refreshed = await capabilities.kinds([alice], 60_000);
    expect(chain.calls).toEqual([alice, alice]);
    expect(refreshed[0]?.checked_at).toBe(new Date(60_000).toISOString());
  });

  test("de-duplicates concurrent and repeated lookups of the same address", async () => {
    const gate = deferred<WalletKind>();
    const chain = chainReader(() => gate.promise);
    const capabilities = new WalletCapabilities(chain);
    const first = capabilities.kinds([alice, alice], 0);
    const second = capabilities.kinds([alice], 0);
    gate.resolve("base_account");
    const rows = await first;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind)).toEqual(["base_account", "base_account"]);
    expect((await second)[0]?.kind).toBe("base_account");
    expect(chain.calls).toEqual([alice]);
  });

  test("fails soft on an RPC error and does not cache the failure", async () => {
    let fail = true;
    const chain = chainReader(async () => {
      if (fail) throw new Error("https://rpc.example/PROVIDER-KEY 429 rate limited");
      return "base_account";
    });
    const capabilities = new WalletCapabilities(chain);
    const failed = await capabilities.kinds([alice], 0);
    expect(failed[0]).toEqual({
      address: alice,
      kind: null,
      can_authorize_spending: false,
      checked: false,
      checked_at: null,
    });
    fail = false;
    // Same instant: a cached failure would have kept returning null for the whole TTL.
    expect((await capabilities.kinds([alice], 0))[0]?.kind).toBe("base_account");
    expect(chain.calls).toEqual([alice, alice]);
  });

  test("bounds the cache so an address set cannot pin memory", async () => {
    const chain = chainReader(async () => "eoa");
    const capabilities = new WalletCapabilities(chain, 60_000, 3);
    const addresses = [1, 2, 3, 4].map((n) => `0x${String(n).repeat(40)}`.slice(0, 42) as Hex);
    for (const address of addresses) await capabilities.kinds([address], 0);
    expect(chain.calls).toHaveLength(4);
    // The fourth write evicted the oldest entry, so the first address is read again while the
    // most recent one is still served from cache.
    await capabilities.kinds([addresses[3] as Hex], 1);
    expect(chain.calls).toHaveLength(4);
    await capabilities.kinds([addresses[0] as Hex], 1);
    expect(chain.calls).toHaveLength(5);
  });

  test("bounds chain lookups per request and fills the rest on the next poll", async () => {
    const chain = chainReader(async () => "eoa");
    const capabilities = new WalletCapabilities(chain, 60_000, 512, 2);
    const wallets = [alice, bob, mallory];
    const first = await capabilities.kinds(wallets, 0);
    expect(first.map((row) => row.checked)).toEqual([true, true, false]);
    expect(chain.calls).toEqual([alice, bob]);
    const second = await capabilities.kinds(wallets, 1);
    expect(second.map((row) => row.checked)).toEqual([true, true, true]);
    expect(chain.calls).toEqual([alice, bob, mallory]);
  });

  test("never rejects, whatever the chain does", async () => {
    const chain = chainReader(async () => {
      throw new Error("boom");
    });
    const rows = await new WalletCapabilities(chain).kinds([alice, bob], 0);
    expect(rows.map((row) => [row.kind, row.checked, row.checked_at])).toEqual([
      [null, false, null],
      [null, false, null],
    ]);
  });
});

describe("GET /v1/me/wallets", () => {
  test("reports each linked wallet's automation capability", async () => {
    const chain = chainReader(async (address) => (address === alice ? "base_account" : "eoa"));
    const app = await harness({ wallets: [alice, bob], deps: { chain } });
    const response = await app.inject({ url: "/v1/me/wallets", headers: signedIn() });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Array<Record<string, unknown>>; chain_id: number }>();
    expect(body.items.map((item) => [item.address, item.can_authorize_spending])).toEqual([
      [alice, true],
      [bob, false],
    ]);
    expect(body.chain_id).toBe(8453);
    expect(response.json<{ notice: string }>().notice).toContain("re-checked");
  });

  test("requires authentication", async () => {
    const app = await harness({ deps: { chain: chainReader(async () => "eoa") } });
    expect((await app.inject({ url: "/v1/me/wallets" })).statusCode).toBe(401);
  });

  test("answers 503 rather than inventing a capability when no chain reader is injected", async () => {
    const app = await harness();
    const response = await app.inject({ url: "/v1/me/wallets", headers: signedIn() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "unavailable", status: 503 });
  });

  test("degrades one row instead of leaking the upstream error", async () => {
    const chain = chainReader(async () => {
      throw new Error("https://base-mainnet.example/v2/PROVIDER-KEY refused");
    });
    const app = await harness({ wallets: [alice], deps: { chain } });
    const response = await app.inject({ url: "/v1/me/wallets", headers: signedIn() });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Array<{ kind: unknown }> }>().items[0]?.kind).toBeNull();
    expect(response.body).not.toContain("PROVIDER-KEY");
  });

  test("applies a stricter per-route rate limit than the global limit", async () => {
    const chain = chainReader(async () => "eoa");
    const app = await harness({ wallets: [alice], deps: { chain }, globalRateLimit: 1000 });
    const codes: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      codes.push((await app.inject({ url: "/v1/me/wallets", headers: signedIn() })).statusCode);
    }
    expect(codes.slice(0, 20).every((code) => code === 200)).toBe(true);
    expect(codes[20]).toBe(429);
    // The global limit is untouched, so identity still resolves after the capability route trips.
    expect((await app.inject({ url: "/v1/me", headers: signedIn() })).statusCode).toBe(200);
  });
});
