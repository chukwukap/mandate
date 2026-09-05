import type { FastifyPluginAsync } from "fastify";
import { plugin } from "./plugin.js";

/**
 * Correlation id and cache posture for every response.
 *
 * `request.id` is server-generated because the server is built with `requestIdHeader: false`;
 * a client-supplied `x-request-id` is therefore never trusted or echoed. That matters for more
 * than tidiness: the id is what the Problem error handler puts in `request_id`, and support
 * uses it to find the log line. If a caller could choose it, two unrelated requests could claim
 * the same id and the audit trail would stop being an audit trail.
 *
 * The header is set in `onRequest` rather than `onSend` so that it also lands on responses
 * produced by a hook that throws — a 401 from authentication or a 403 from the origin guard is
 * exactly the response an operator most needs to correlate.
 *
 * `cache-control: no-store` is unconditional. Every response here is either per-user financial
 * state or a liveness verdict; both are wrong to serve from a shared cache, a browser
 * back/forward cache, or a CDN that decided a 200 with no directives was fair game.
 */
export const requestContext: FastifyPluginAsync = plugin(
  async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      reply.header("x-request-id", request.id);
      reply.header("cache-control", "no-store");
    });
  },
  { name: "mandate-request-context" },
);
