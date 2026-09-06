import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_PUBLIC_PATHS } from "../../apps/api/src/plugins/index.js";
import {
  type ContractApi,
  call,
  newIdentity,
  startContractApi,
  type TestIdentity,
} from "./harness.js";

/**
 * The OpenAPI document the API serves at `/openapi.json`.
 *
 * It is generated from the same `schema` objects fastify validates requests against, which is
 * what makes it worth pinning: it is not documentation kept beside the code, it *is* the code.
 * A route that loses its `security` block has become anonymous in the document and, far more
 * importantly, a route that gains a path is a route somebody added — this file is where an
 * unreviewed endpoint shows up.
 *
 * The path list below is exhaustive and deliberately hard-coded. A generated assertion
 * ("every path has a summary") passes for a route nobody meant to publish; an exact list does
 * not, and updating it is the moment somebody reads the diff.
 */

/** Every path the API publishes. Adding one to the app without adding it here fails. */
const PATHS = [
  "/health",
  "/ready",
  "/v1/executions",
  "/v1/executions/{id}",
  "/v1/instances",
  "/v1/instances/{id}",
  "/v1/instances/{id}/arm",
  "/v1/instances/{id}/evaluations",
  "/v1/instances/{id}/executions",
  "/v1/instances/{id}/executions/summary",
  "/v1/instances/{id}/kill",
  "/v1/instances/{id}/pause",
  "/v1/instances/{id}/permission",
  "/v1/instances/{id}/permission/activate",
  "/v1/instances/{id}/permission/revoke",
  "/v1/market",
  "/v1/market/candles",
  "/v1/market/quote",
  "/v1/me",
  "/v1/me/wallets",
  "/v1/permissions",
  "/v1/permissions/prepare",
  "/v1/strategies",
  "/v1/strategies/draft",
] as const;

type Operation = {
  summary?: string;
  tags?: string[];
  security?: unknown[];
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
  parameters?: { name: string; in: string; required: boolean }[];
};
type Document = {
  openapi: string;
  info: { title: string; version: string };
  components: { securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, Operation>>;
};

let api: ContractApi;
let alice: TestIdentity;
let doc: Document;

beforeAll(async () => {
  alice = newIdentity();
  api = await startContractApi({ identities: [alice] });
  const response = await call(api, { url: "/openapi.json" });
  expect(response.statusCode).toBe(200);
  doc = response.json<Document>();
}, 60_000);

afterAll(async () => {
  await api.close();
}, 30_000);

describe("the served document", () => {
  test("declares OpenAPI 3, the API's name and its version", () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe("Mandate API");
    expect(doc.info.version).toBe("2.0.0");
  });

  test("declares exactly one security scheme, a Privy bearer token", () => {
    expect(Object.keys(doc.components.securitySchemes)).toEqual(["privy"]);
    expect(doc.components.securitySchemes.privy).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
  });

  test("publishes exactly the routes this API serves, and no others", () => {
    expect(Object.keys(doc.paths).sort()).toEqual([...PATHS].sort());
  });

  test("the catch-all preflight and the document itself are hidden", () => {
    // `OPTIONS /*` and `/openapi.json` both carry `schema: { hide: true }`. A wildcard path in
    // the document would tell a generator to emit a client method for it, and a preflight is
    // not an endpoint anyone calls deliberately.
    expect(doc.paths).not.toHaveProperty("/*");
    expect(doc.paths).not.toHaveProperty("/openapi.json");
  });

  test("every operation carries a summary and a tag", () => {
    for (const [path, operations] of Object.entries(doc.paths))
      for (const [method, operation] of Object.entries(operations)) {
        expect(operation.summary, `${method} ${path}`).toBeTruthy();
        expect(operation.tags?.length, `${method} ${path}`).toBeGreaterThan(0);
      }
  });
});

describe("what the document says about authentication", () => {
  test("every /v1 operation requires the bearer token except the public catalogue", () => {
    const anonymous: string[] = [];
    for (const [path, operations] of Object.entries(doc.paths)) {
      if (!path.startsWith("/v1")) continue;
      for (const operation of Object.values(operations))
        if (!operation.security?.length) anonymous.push(path);
    }
    // The document and the runtime allowlist are two independent statements of one rule, and
    // this is where they are checked against each other. A `/v1` route that quietly lost its
    // `security` block is a route a generated client would call without a token.
    expect(anonymous.sort()).toEqual([...DEFAULT_PUBLIC_PATHS].sort());
    // Both are read-only market data the landing page shows before a wallet is connected.
    expect(anonymous).toEqual(["/v1/market", "/v1/market/candles"]);
  });

  test("the runtime agrees: the documented-anonymous path is the only one served anonymously", async () => {
    for (const path of PATHS) {
      if (path.includes("{id}") || path.startsWith("/health") || path.startsWith("/ready"))
        continue;
      const response = await call(api, { url: path, method: "GET" });
      // The property under test is whether the AUTH gate let the request through, so a public
      // path must not answer 401. It may still answer 400: /v1/market/candles requires a symbol,
      // and being rejected for a missing parameter is proof the request reached the handler.
      if (DEFAULT_PUBLIC_PATHS.includes(path)) {
        expect(response.statusCode).not.toBe(401);
        expect([200, 400]).toContain(response.statusCode);
      }
      // Everything else is 401 or 404-for-the-method, never a 200 body.
      else expect(response.statusCode).not.toBe(200);
    }
  });

  test("the two probes are outside /v1 and carry no security requirement", () => {
    for (const path of ["/health", "/ready"]) {
      const operation = doc.paths[path]?.get;
      expect(operation?.tags).toEqual(["health"]);
      expect(operation?.security).toBeUndefined();
    }
  });
});

describe("what the document says about request shapes", () => {
  test("every POST that takes a body publishes its JSON Schema", () => {
    const bodied = [
      "/v1/strategies",
      "/v1/strategies/draft",
      "/v1/permissions",
      "/v1/permissions/prepare",
      "/v1/market/quote",
      "/v1/instances/{id}/permission/activate",
    ];
    for (const path of bodied) {
      const schema = doc.paths[path]?.post?.requestBody?.content["application/json"]?.schema;
      expect(schema, path).toBeDefined();
      // Every body contract in this API is a zod `strictObject`, so the generated schema
      // refuses unknown keys. That is what stops a caller from smuggling a `user_id` field
      // into a request whose handler scopes on the verified principal.
      expect(schema?.additionalProperties, path).toBe(false);
    }
  });

  test("the quote body publishes the exact leaf rules the route parses with", () => {
    const schema = doc.paths["/v1/market/quote"]?.post?.requestBody?.content["application/json"]
      ?.schema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    // `amount` is a string with a decimal pattern and never a number: 100.000001 USDC is exact
    // as a string and is not representable as a float64, and this value is a spend.
    expect(schema.properties.amount?.type).toBe("string");
    expect(schema.properties.amount?.pattern).toBe("^\\d{1,30}(\\.\\d{1,18})?$");
    // 500 bps is the reference band packages/evm enforces; a larger tolerance is unusable, so
    // the document says so rather than letting a client discover it as a 503.
    expect(schema.properties.slippage_bps?.maximum).toBe(500);
    expect(schema.properties.slippage_bps?.default).toBe(50);
    expect(schema.required.sort()).toEqual(["amount", "side", "symbol"]);
  });

  test("every path with an {id} segment declares it as a required uuid parameter", () => {
    for (const path of PATHS) {
      if (!path.includes("{id}")) continue;
      for (const [method, operation] of Object.entries(doc.paths[path] ?? {})) {
        const id = operation.parameters?.find((parameter) => parameter.name === "id");
        expect(id, `${method} ${path}`).toBeDefined();
        expect(id?.in).toBe("path");
        expect(id?.required).toBe(true);
      }
    }
  });
});

describe("when the document is switched off", () => {
  test("/openapi.json is not served at all, and it is not a 500", async () => {
    const closed = await startContractApi({ identities: [alice], config: { API_DOCS: "0" } });
    try {
      const response = await call(closed, { url: "/openapi.json" });
      // 404 through the app's own not-found handler, which is an RFC7807 body like every other
      // failure. A deployment with docs off must not leak the route list, and must not error.
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      // Every real route still works with the document withheld.
      expect((await call(closed, { url: "/v1/market" })).statusCode).toBe(200);
    } finally {
      await closed.close();
    }
  }, 60_000);
});
