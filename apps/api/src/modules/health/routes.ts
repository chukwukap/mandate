import type { FastifyInstance } from "fastify";
import {
  createReadinessProbe,
  type ReadinessDependencies,
  type ReadinessOptions,
} from "./readiness.js";

export type HealthDependencies = ReadinessDependencies;

export interface HealthOptions {
  readonly readiness?: ReadinessOptions;
}

/**
 * Liveness and readiness, which are different questions with different consequences.
 *
 * `GET /health` — is this process running? It touches no dependency, on purpose. A liveness
 * probe that consulted PostgreSQL would fail on every replica simultaneously during a single
 * database outage, and the orchestrator would respond by killing all of them: a recoverable
 * dependency incident converted into a total one, with a restart storm on top that the database
 * then has to survive. "Improving" this handler by adding a real check is the tempting mistake;
 * that is what /ready is for.
 *
 * `GET /ready` — should this instance receive traffic? Database and chain must both answer.
 * Routing a request to an instance that cannot reach PostgreSQL produces a 500 for a user
 * instead of a retry against a healthy replica, which is exactly what readiness exists to
 * prevent.
 *
 * `execution_available` is reported but never affects the verdict. It is a worker heartbeat: an
 * API instance with no worker behind it can still serve every read and still accept a signed
 * strategy, so failing readiness on it would take the API down for a worker deploy.
 */
export async function registerHealth(
  app: FastifyInstance,
  deps: HealthDependencies,
  options: HealthOptions = {},
): Promise<void> {
  const readiness = createReadinessProbe(deps, options.readiness ?? {});

  app.get(
    "/health",
    {
      schema: { tags: ["health"], summary: "Process liveness" },
      // Probe traffic must not consume the global 120/min per-IP budget. A load balancer
      // polling from one source IP once a second is 60/min per endpoint, and a 429 reads to the
      // orchestrator as "unhealthy" — a rate limiter restarting healthy instances is a
      // self-inflicted outage. /ready's cost is bounded by its probe cache instead.
      config: { rateLimit: false },
    },
    async () => ({ status: "ok" }),
  );

  app.get(
    "/ready",
    {
      schema: { tags: ["health"], summary: "Database and chain readiness" },
      config: { rateLimit: false },
    },
    async (_request, reply) => {
      const report = await readiness();
      // The body is pinned by apps/api/test/http.test.ts to exactly these four keys. Diagnostic
      // detail (latency, which check timed out, version) belongs in logs, not here: this
      // response is public and unauthenticated, so every field added is a field an unauthorised
      // caller can fingerprint the deployment with.
      return reply.code(report.ready ? 200 : 503).send({
        status: report.ready ? "ready" : "unavailable",
        database: report.database,
        chain: report.chain,
        execution_available: report.execution,
      });
    },
  );
}
