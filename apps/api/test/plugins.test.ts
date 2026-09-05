import { afterEach, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { Authenticator } from "@mandate/auth";
import { type Config, loadConfig } from "@mandate/config";
import { Problem } from "@mandate/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import {
  DEFAULT_PUBLIC_PATHS,
  PREFLIGHT_HEADERS,
  PREFLIGHT_METHODS,
  protectedRequest,
  registerPlugins,
  requireEligible,
  requirePrincipal,
} from "../src/plugins/index.js";

const opened: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

function config(overrides: Record<string, string> = {}): Config {
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

/** Counts every call so a test can assert a hook ran *before* authentication was reached. */
function recordingAuth() {
  const calls: (string | undefined)[] = [];
  const auth: Authenticator = {
    authenticate: async (header) => {
      calls.push(header);
      if (header === "Bearer outage")
        throw Problem.unavailable("Authentication verification is temporarily unavailable.");
      if (header !== "Bearer valid") throw Problem.unauthenticated();
      return {
        privyDid: "did:privy:alice",
        sessionId: "s",
        wallets: ["0x1111111111111111111111111111111111111111"],
      };
    },
  };
  return { auth, calls };
}

interface Harness {
  app: FastifyInstance;
  authCalls: (string | undefined)[];
  resolveCalls: string[];
}

/**
 * A bare server carrying only the plugins under test. It deliberately does not go through
 * buildApp: these assertions must fail when a plugin regresses, not when app.ts changes.
 * The error handler mirrors only the Problem mapping app.ts owns, because fastify's default
 * handler reports every thrown Problem as 500 (Problem carries `status`, not `statusCode`).
 */
async function harness(
  overrides: { config?: Config; publicPaths?: readonly string[] } = {},
): Promise<Harness> {
  const { auth, calls: authCalls } = recordingAuth();
  const resolveCalls: string[] = [];
  const app = Fastify({ logger: false, requestIdHeader: false, trustProxy: false });
  app.setErrorHandler((error, request, reply) => {
    const problem = error instanceof Problem ? error : new Problem(500, "internal-error", "e", "e");
    void reply
      .code(problem.status)
      .type("application/problem+json")
      .send({ status: problem.status, code: problem.code, request_id: request.id });
  });
  await registerPlugins(app, {
    config: overrides.config ?? config(),
    auth,
    users: {
      resolvePrivyUser: async (did) => {
        resolveCalls.push(did);
        return { id: "local-user" };
      },
    },
    ...(overrides.publicPaths ? { publicPaths: overrides.publicPaths } : {}),
  });

  app.options("/*", async (_request, reply) => {
    return reply
      .header("access-control-allow-methods", PREFLIGHT_METHODS)
      .header("access-control-allow-headers", PREFLIGHT_HEADERS)
      .code(204)
      .send();
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/market", async (request) => ({
    principal: request.principal,
    jurisdiction: request.jurisdiction,
    eligible: request.eligible,
  }));
  app.post("/v1/market/quote", async (request) => {
    requireEligible(request);
    return { user: requirePrincipal(request).user };
  });
  app.get("/v1/me", async (request) => ({
    user: requirePrincipal(request).user,
    jurisdiction: request.jurisdiction,
    eligible: request.eligible,
  }));
  opened.push(app);
  await app.ready();
  return { app, authCalls, resolveCalls };
}

test("the correlation id is server-generated and a client-supplied one is ignored", async () => {
  const { app } = await harness();
  const response = await app.inject({
    url: "/health",
    headers: { "x-request-id": "untrusted" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["x-request-id"]).toBeString();
  expect(response.headers["x-request-id"]).not.toBe("untrusted");
  expect(response.headers["cache-control"]).toBe("no-store");
});

test("the correlation id is present on responses produced by a failing hook", async () => {
  // The id is set in onRequest precisely so a 401 or 403 can still be traced to a log line.
  const { app } = await harness();
  const denied = await app.inject({ url: "/v1/me", headers: { origin: "https://attacker.test" } });
  expect(denied.statusCode).toBe(403);
  expect(denied.headers["x-request-id"]).toBeString();
  expect(denied.json().request_id).toBe(denied.headers["x-request-id"]);
});

test("a foreign origin is rejected before the token is ever examined", async () => {
  // Ordering assertion: if authentication were registered before the origin guard this would
  // be a 200 for the valid bearer, and an attacker page could drive free Privy round trips.
  const { app, authCalls } = await harness();
  const response = await app.inject({
    url: "/v1/me",
    headers: { origin: "https://attacker.test", authorization: "Bearer valid" },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe("origin-denied");
  expect(authCalls).toEqual([]);
});

test("the configured origin is echoed and varied on", async () => {
  const { app } = await harness();
  const response = await app.inject({
    url: "/v1/me",
    headers: { origin: "http://localhost:3000", authorization: "Bearer valid" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  expect(response.headers.vary).toBe("Origin");
});

test("a non-browser client without an Origin header gets no allow-origin header", async () => {
  const { app } = await harness();
  const response = await app.inject({ url: "/health" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
});

test("the literal origin 'null' is denied", async () => {
  // Sandboxed iframes and some redirect chains send Origin: null. It is not our origin.
  const { app } = await harness();
  const response = await app.inject({ url: "/health", headers: { origin: "null" } });
  expect(response.statusCode).toBe(403);
});

test("preflight succeeds without a token and skips authentication entirely", async () => {
  const { app, authCalls } = await harness();
  const response = await app.inject({
    method: "OPTIONS",
    url: "/v1/me",
    headers: { origin: "http://localhost:3000" },
  });
  expect(response.statusCode).toBe(204);
  expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  expect(response.headers["access-control-allow-methods"]).toBe(PREFLIGHT_METHODS);
  expect(authCalls).toEqual([]);
});

test("a missing token on a protected route is 401, not 500", async () => {
  const { app } = await harness();
  const response = await app.inject({ url: "/v1/me" });
  expect(response.statusCode).toBe(401);
  expect(response.json().code).toBe("unauthenticated");
});

test("a valid token resolves the local user and attaches it as the principal", async () => {
  const { app, resolveCalls } = await harness();
  const response = await app.inject({ url: "/v1/me", headers: { authorization: "Bearer valid" } });
  expect(response.statusCode).toBe(200);
  expect(response.json().user).toBe("local-user");
  expect(resolveCalls).toEqual(["did:privy:alice"]);
});

test("a provider outage surfaces as 503, never as a bogus 401", async () => {
  // Remapping every authentication failure to 401 would tell every signed-in user their
  // session was revoked during a Privy blip, sending the whole user base back to a dead IdP.
  const { app } = await harness();
  const response = await app.inject({ url: "/v1/me", headers: { authorization: "Bearer outage" } });
  expect(response.statusCode).toBe(503);
  expect(response.json().code).toBe("unavailable");
});

test("the public catalogue is anonymous but the quote route under it is not", async () => {
  const { app, authCalls } = await harness();
  const anonymous = await app.inject({ url: "/v1/market" });
  expect(anonymous.statusCode).toBe(200);
  expect(anonymous.json().principal).toBeNull();
  expect(authCalls).toEqual([]);

  const quote = await app.inject({ method: "POST", url: "/v1/market/quote" });
  expect(quote.statusCode).toBe(401);
  expect(authCalls).toEqual([undefined]);
});

test("the public allowlist is an exact path list, not a prefix", async () => {
  expect(DEFAULT_PUBLIC_PATHS).toEqual(["/v1/market"]);
  expect(protectedRequest("/v1/market", DEFAULT_PUBLIC_PATHS)).toBe(false);
  expect(protectedRequest("/v1/market?refresh=1", DEFAULT_PUBLIC_PATHS)).toBe(false);
  expect(protectedRequest("/v1/market/quote", DEFAULT_PUBLIC_PATHS)).toBe(true);
  expect(protectedRequest("/v1/marketing", DEFAULT_PUBLIC_PATHS)).toBe(true);
  expect(protectedRequest("/health", DEFAULT_PUBLIC_PATHS)).toBe(false);
  expect(protectedRequest("/ready", DEFAULT_PUBLIC_PATHS)).toBe(false);
  expect(protectedRequest("/openapi.json", DEFAULT_PUBLIC_PATHS)).toBe(false);
});

test("an absolute-form request target cannot slip past the /v1 gate", async () => {
  // Node accepts `GET http://host/v1/me HTTP/1.1` and hands request.url through verbatim while
  // find-my-way still routes it to /v1/me, so a bare startsWith("/v1/") check skips auth.
  expect(protectedRequest("http://mandate.test/v1/me", DEFAULT_PUBLIC_PATHS)).toBe(true);
  expect(protectedRequest("https://mandate.test/v1/instances/x/arm", DEFAULT_PUBLIC_PATHS)).toBe(
    true,
  );
  expect(protectedRequest("http://mandate.test/v1/market", DEFAULT_PUBLIC_PATHS)).toBe(false);
  // The reverse hole: `//v1/me` parses to pathname "/me", so the raw form must also be checked.
  expect(protectedRequest("//v1/me", ["/me"])).toBe(false);
  expect(protectedRequest("/v1/%6de", DEFAULT_PUBLIC_PATHS)).toBe(true);
});

test("an absolute-form request line over a real socket is challenged", async () => {
  const { app } = await harness();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const status = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET http://127.0.0.1:${port}/v1/me HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(buffer.split("\r\n")[0] ?? ""));
  });
  expect(status).toContain("401");
});

test("a spoofed country header from an untrusted peer is ignored", async () => {
  const { app } = await harness();
  const response = await app.inject({
    url: "/v1/me",
    headers: { authorization: "Bearer valid", "cf-ipcountry": "GB" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ jurisdiction: "XX", eligible: false });
});

test("the country header is honoured only from the exact trusted proxy IP", async () => {
  const { app } = await harness({
    config: config({ TRUSTED_PROXY_IPS: "203.0.113.7", ELIGIBLE_COUNTRIES: "GB" }),
  });
  const trusted = await app.inject({
    url: "/v1/me",
    remoteAddress: "203.0.113.7",
    headers: { authorization: "Bearer valid", "cf-ipcountry": "GB" },
  });
  expect(trusted.json()).toMatchObject({ jurisdiction: "GB", eligible: true });

  const neighbour = await app.inject({
    url: "/v1/me",
    remoteAddress: "203.0.113.8",
    headers: { authorization: "Bearer valid", "cf-ipcountry": "GB" },
  });
  expect(neighbour.json()).toMatchObject({ jurisdiction: "XX", eligible: false });
});

test("an ineligible jurisdiction is authenticated but cannot trade", async () => {
  const { app } = await harness({
    config: config({ TRUSTED_PROXY_IPS: "203.0.113.7", ELIGIBLE_COUNTRIES: "GB" }),
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/market/quote",
    remoteAddress: "203.0.113.7",
    headers: { authorization: "Bearer valid", "cf-ipcountry": "FR" },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe("not-eligible");
});

test("a US peer is never eligible even if the allowlist is misconfigured", async () => {
  // eligible() hard-codes the US and XX rejections; config validation also refuses to list US.
  const { app } = await harness({
    config: config({ TRUSTED_PROXY_IPS: "203.0.113.7", ELIGIBLE_COUNTRIES: "GB" }),
  });
  const response = await app.inject({
    url: "/v1/market",
    remoteAddress: "203.0.113.7",
    headers: { "cf-ipcountry": "US" },
  });
  expect(response.json()).toMatchObject({ jurisdiction: "US", eligible: false });
});

test("anonymous requests still carry the closed decorator defaults", async () => {
  const { app } = await harness();
  const response = await app.inject({ url: "/v1/market" });
  expect(response.json<Record<string, unknown>>()).toEqual({
    principal: null,
    jurisdiction: "XX",
    eligible: false,
  });
});

test("a caller-supplied public allowlist opens exactly the paths it names", async () => {
  const { app, authCalls } = await harness({ publicPaths: ["/v1/market", "/v1/status"] });
  expect((await app.inject({ url: "/v1/market" })).statusCode).toBe(200);
  expect((await app.inject({ url: "/v1/status" })).statusCode).toBe(404);
  expect(authCalls).toEqual([]);
  expect((await app.inject({ url: "/v1/me" })).statusCode).toBe(401);
});

test("registration tolerates decorators app.ts may still be installing itself", async () => {
  // Handoff window: a second unguarded decorateRequest for the same key is a boot failure.
  const app = Fastify({ logger: false });
  app.decorateRequest("principal", null);
  app.decorateRequest("jurisdiction", "XX");
  app.decorateRequest("eligible", false);
  const { auth } = recordingAuth();
  await registerPlugins(app, {
    config: config(),
    auth,
    users: { resolvePrivyUser: async () => ({ id: "local-user" }) },
  });
  app.get("/v1/market", async (request) => ({ eligible: request.eligible }));
  opened.push(app);
  await app.ready();
  expect((await app.inject({ url: "/v1/market" })).json<Record<string, unknown>>()).toEqual({
    eligible: false,
  });
});

test("the plugins run as root hooks rather than inside an encapsulated child", async () => {
  // Without the skip-override marker every hook here would apply only to routes declared
  // inside the plugin - i.e. none of them - and every /v1 route would be unauthenticated.
  const { app } = await harness();
  expect((await app.inject({ url: "/v1/me" })).statusCode).toBe(401);
  expect((await app.inject({ url: "/health" })).headers["cache-control"]).toBe("no-store");
});
