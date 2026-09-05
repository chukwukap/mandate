import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import type { Authenticator } from "@mandate/auth";
import type { Config } from "@mandate/config";
import { Problem } from "@mandate/contracts";
import { loggerOptions } from "@mandate/observability";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerAuth } from "./modules/auth/index.js";
import type { ExecutionDependencies } from "./modules/executions/index.js";
import { registerExecutions, registerInstanceExecutions } from "./modules/executions/index.js";
import { registerHealth } from "./modules/health/index.js";
import { registerInstanceAliases, registerInstances } from "./modules/instances/index.js";
import { registerMarket } from "./modules/market/index.js";
import { registerPermissions } from "./modules/permissions/index.js";
import { registerTrading, type TradingDependencies } from "./modules/strategies/routes.js";
import { PREFLIGHT_HEADERS, PREFLIGHT_METHODS, registerPlugins } from "./plugins/index.js";

export interface ApiDependencies {
  trading?: TradingDependencies;
  config: Config;
  auth: Authenticator;
  users: { resolvePrivyUser(did: string): Promise<{ id: string }> };
  databaseReady(): Promise<boolean>;
  workerAvailable?(): Promise<boolean>;
  chainReady(): Promise<boolean>;
  /**
   * Optional overrides for the executions module.
   *
   * Here rather than registered separately by the caller because every path has exactly one
   * owner: registering the module twice is FST_ERR_DUPLICATED_ROUTE at boot, so a test that
   * needs a receipt reader has to inject it through this rather than call the registrar again.
   */
  executions?: Omit<ExecutionDependencies, "repository">;
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

  // The request pipeline before any route. registerPlugins fixes the order internally, because
  // inverting it fails silently rather than loudly — see the comment on that function. It also
  // creates the `principal`, `jurisdiction` and `eligible` request decorators, and fastify
  // requires a decorator to exist before the routes referencing it are built.
  await registerPlugins(app, { config, auth: deps.auth, users: deps.users });

  // Preflight stays here rather than inside the cors plugin: a second registration of this path
  // is FST_ERR_DUPLICATED_ROUTE at boot, so exactly one owner may declare it.
  app.options("/*", { schema: { hide: true } }, async (_request, reply) => {
    return reply
      .header("access-control-allow-methods", PREFLIGHT_METHODS)
      .header("access-control-allow-headers", PREFLIGHT_HEADERS)
      .code(204)
      .send();
  });

  await registerHealth(app, deps);
  await registerAuth(app, config, {
    ...(deps.trading ? { chain: deps.trading.chain } : {}),
    ...(deps.workerAvailable ? { workerAvailable: deps.workerAvailable } : {}),
  });

  if (config.docs) app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  if (deps.trading) {
    const trading = deps.trading;
    // One heartbeat reader shared by every module that reports execution availability, so a
    // single request cannot fan out into several identical worker_state queries.
    const executionAvailable = async () => (await deps.workerAvailable?.().catch(() => false)) ?? false;

    await registerMarket(app, {
      chain: trading.chain,
      assets: trading.assets,
      executionAvailable,
    });

    const instances = { repository: trading.repository, chain: trading.chain, executionAvailable };
    await registerInstances(app, instances);
    // /v1/strategies POST and GET are the older names for the same two routes. They are
    // registered here, once, rather than by the strategies module.
    await registerInstanceAliases(app, instances);

    await registerPermissions(app, config, {
      repository: trading.repository,
      chain: trading.chain,
    });

    const executions = { repository: trading.repository, ...(deps.executions ?? {}) };
    await registerExecutions(app, executions);
    await registerInstanceExecutions(app, executions);

    // Everything except POST /v1/strategies/draft has moved out of this module.
    await registerTrading(app, config, trading);
  }

  return app;
}
