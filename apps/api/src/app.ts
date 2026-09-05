import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { type AuthenticatedUser, type Authenticator, eligible, jurisdiction } from "@mandate/auth";
import type { Config } from "@mandate/config";
import { Problem } from "@mandate/contracts";
import { loggerOptions } from "@mandate/observability";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerTrading, type TradingDependencies } from "./modules/strategies/routes.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: (AuthenticatedUser & { user: string }) | null;
    jurisdiction: string;
    eligible: boolean;
  }
}

export interface ApiDependencies {
  trading?: TradingDependencies;
  config: Config;
  auth: Authenticator;
  users: { resolvePrivyUser(did: string): Promise<{ id: string }> };
  databaseReady(): Promise<boolean>;
  workerAvailable?(): Promise<boolean>;
  chainReady(): Promise<boolean>;
}

export async function buildApp(deps: ApiDependencies) {
  const { config } = deps;
  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    bodyLimit: 128 * 1024,
    requestTimeout: 60_000,
    connectionTimeout: 10_000,
    requestIdHeader: false,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.decorateRequest("principal", null);
  app.decorateRequest("jurisdiction", "XX");
  app.decorateRequest("eligible", false);
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: { title: "Mandate API", version: "2.0.0" },
      components: {
        securitySchemes: { privy: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    },
  });

  app.setErrorHandler((error, request, reply) => {
    const e = error as Error & { statusCode?: number; validation?: unknown };
    const problem =
      error instanceof Problem
        ? error
        : e.validation || error instanceof ZodError
          ? new Problem(
              400,
              "invalid-request",
              "Invalid request",
              "The request does not match the endpoint schema.",
            )
          : e.statusCode && e.statusCode >= 400 && e.statusCode < 500
            ? new Problem(
                e.statusCode,
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
    // Never log upstream error objects; SDK errors can include credentials or bodies.
    if (problem.status >= 500) request.log.error({ code: problem.code }, "Request failed");
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
  app.setNotFoundHandler(() => {
    throw Problem.notFound();
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
    const origin = request.headers.origin;
    if (origin && origin !== config.origin)
      throw new Problem(
        403,
        "origin-denied",
        "Origin denied",
        "This origin cannot access the API.",
      );
    if (origin === config.origin) {
      reply.header("access-control-allow-origin", config.origin).header("vary", "Origin");
    }
    if (request.method === "OPTIONS") return;
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
    const path = request.url.split("?")[0];
    if (path?.startsWith("/v1/") && path !== "/v1/market") {
      const authenticated = await deps.auth.authenticate(request.headers.authorization);
      const user = await deps.users.resolvePrivyUser(authenticated.privyDid);
      request.principal = { ...authenticated, user: user.id };
    }
  });

  app.options("/*", { schema: { hide: true } }, async (_request, reply) => {
    return reply
      .header("access-control-allow-methods", "GET, POST, OPTIONS")
      .header("access-control-allow-headers", "Authorization, Content-Type, X-Mandate-Wallet")
      .code(204)
      .send();
  });
  app.get("/health", { schema: { tags: ["health"], summary: "Process liveness" } }, async () => ({
    status: "ok",
  }));
  app.get(
    "/ready",
    { schema: { tags: ["health"], summary: "Database and chain readiness" } },
    async (_request, reply) => {
      const checks = await Promise.allSettled([deps.databaseReady(), deps.chainReady()]);
      const database = checks[0].status === "fulfilled" && checks[0].value;
      const chain = checks[1].status === "fulfilled" && checks[1].value;
      return reply.code(database && chain ? 200 : 503).send({
        status: database && chain ? "ready" : "unavailable",
        database,
        chain,
        execution_available: (await deps.workerAvailable?.().catch(() => false)) ?? false,
      });
    },
  );
  app.get(
    "/v1/me",
    {
      schema: {
        tags: ["auth"],
        summary: "Current verified Privy identity",
        security: [{ privy: [] }],
      },
    },
    async (request) => {
      if (!request.principal) throw Problem.unauthenticated();
      return {
        user: request.principal.user,
        privy_did: request.principal.privyDid,
        wallets: request.principal.wallets,
        jurisdiction: request.jurisdiction,
        eligible: request.eligible,
        server_time: new Date().toISOString(),
        execution_available: (await deps.workerAvailable?.().catch(() => false)) ?? false,
      };
    },
  );
  if (config.docs) app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  if (deps.trading) await registerTrading(app, config, deps.trading);
  return app;
}
