import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "@mandate/config";
import { Problem } from "@mandate/contracts";
import { type ApiDependencies, buildApp } from "../src/app.js";

const opened: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});
async function setup(overrides: Partial<ApiDependencies> = {}) {
  const app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://local:local@localhost/test",
      PRIVY_APP_ID: "test",
      PRIVY_APP_SECRET: "secret",
      LOG_LEVEL: "silent",
      API_DOCS: "1",
      ELIGIBLE_COUNTRIES: "GB",
    }),
    auth: {
      authenticate: async (header) => {
        if (header !== "Bearer valid") throw Problem.unauthenticated();
        return {
          privyDid: "did:privy:alice",
          sessionId: "s",
          wallets: ["0x1111111111111111111111111111111111111111"],
        };
      },
    },
    users: { resolvePrivyUser: async () => ({ id: "local-user" }) },
    wallets: { embedded: async () => null },
    databaseReady: async () => true,
    chainReady: async () => true,
    ...overrides,
  });
  opened.push(app);
  return app;
}
test("health is public, sets protective headers and generates request IDs", async () => {
  const app = await setup();
  const response = await app.inject({ url: "/health", headers: { "x-request-id": "untrusted" } });
  expect(response.statusCode).toBe(200);
  expect(response.headers["x-request-id"]).not.toBe("untrusted");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
});
test("readiness reports worker availability independently from API readiness", async () => {
  const app = await setup({ workerAvailable: async () => true });
  const response = await app.inject({ url: "/ready" });
  expect(response.statusCode).toBe(200);
  expect(response.json().execution_available).toBe(true);
});
test("protected routes reject missing tokens and return stable problem format", async () => {
  const app = await setup();
  const response = await app.inject({ url: "/v1/me" });
  expect(response.statusCode).toBe(401);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(response.json()).toMatchObject({ status: 401, code: "unauthenticated" });
});
test("me uses server-resolved ownership, ignores spoofed geography", async () => {
  const app = await setup();
  const response = await app.inject({
    url: "/v1/me",
    headers: { authorization: "Bearer valid", "cf-ipcountry": "GB" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    user: "local-user",
    privy_did: "did:privy:alice",
    jurisdiction: "XX",
    eligible: false,
    execution_available: false,
  });
});
test("cross-origin requests are denied, allowed preflight needs no login", async () => {
  const app = await setup();
  expect(
    (
      await app.inject({
        url: "/v1/me",
        headers: { origin: "https://attacker.test", authorization: "Bearer valid" },
      })
    ).statusCode,
  ).toBe(403);
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/v1/me",
    headers: { origin: "http://localhost:3000" },
  });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
});
test("readiness reports dependency failure without claiming execution", async () => {
  const app = await setup({
    databaseReady: async () => {
      throw new Error("secret database url");
    },
  });
  const response = await app.inject({ url: "/ready" });
  expect(response.statusCode).toBe(503);
  expect(response.json<Record<string, unknown>>()).toEqual({
    status: "unavailable",
    database: false,
    chain: true,
    execution_available: false,
  });
});
test("internal errors do not expose credentials", async () => {
  const app = await setup({
    users: {
      resolvePrivyUser: async () => {
        throw new Error("password=secret");
      },
    },
  });
  const response = await app.inject({ url: "/v1/me", headers: { authorization: "Bearer valid" } });
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain("password");
});
test("OpenAPI declares the Privy bearer contract", async () => {
  const app = await setup();
  const response = await app.inject({ url: "/openapi.json" });
  expect(response.statusCode).toBe(200);
  expect(response.json().paths["/v1/me"].get.security).toEqual([{ privy: [] }]);
});

test("the rate limiter's refusal is reported as one, not as a malformed request", async () => {
  const app = await setup();
  const headers = { authorization: "Bearer valid" };
  let last = await app.inject({ url: "/v1/me", headers });
  for (let i = 0; i < 120 && last.statusCode !== 429; i += 1)
    last = await app.inject({ url: "/v1/me", headers });
  expect(last.statusCode).toBe(429);
  expect(last.headers["content-type"]).toContain("application/problem+json");
  expect(last.json()).toMatchObject({ status: 429, code: "rate-limited" });
  expect(last.json().detail).toMatch(/more requests than allowed/);
  expect(last.json().detail).not.toMatch(/request format/);
});
