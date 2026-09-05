import { Problem } from "@mandate/contracts";
import type { FastifyPluginAsync } from "fastify";
import { plugin } from "./plugin.js";

export interface OriginOptions {
  /** The single allowed browser origin, e.g. `https://app.example.com`. */
  readonly origin: string;
}

/**
 * Methods and headers advertised on a successful preflight.
 *
 * Exported so the `OPTIONS /*` route in app.ts can use the same values rather than repeating
 * the literals. This plugin deliberately does NOT register that route: app.ts already owns it,
 * and a second registration of the same method+path is FST_ERR_DUPLICATED_ROUTE at boot.
 */
export const PREFLIGHT_METHODS = "GET, POST, OPTIONS";
export const PREFLIGHT_HEADERS = "Authorization, Content-Type, X-Mandate-Wallet";

/**
 * Single-origin browser guard.
 *
 * The API is bearer-authenticated and sets no cookies, so an attacker page cannot ride an
 * ambient credential. The guard still rejects rather than merely omitting the CORS headers,
 * because a request that arrives with a foreign `Origin` is a browser telling us a page we did
 * not ship is driving the call. Answering 403 makes that visible in logs instead of leaving the
 * browser to swallow a 200 the user never sees.
 *
 * Ordering is a security property, not a style choice: this hook must be registered before
 * authentication so a cross-origin call carrying a *valid* token still gets 403 and never
 * reaches the token verification path. `registerPlugins` fixes that order.
 *
 * A missing or empty `Origin` is a non-browser client (curl, the worker, a probe) and is left
 * alone — matching the behaviour this replaces. The literal string `"null"`, which sandboxed
 * iframes and some redirect chains send, is not the configured origin and so is denied.
 */
export const originGuard: FastifyPluginAsync<OriginOptions> = plugin(
  async (app, options) => {
    const allowed = options.origin;
    app.addHook("onRequest", async (request, reply) => {
      const origin = request.headers.origin;
      if (!origin) return;
      if (origin !== allowed)
        throw new Problem(
          403,
          "origin-denied",
          "Origin denied",
          "This origin cannot access the API.",
        );
      // `vary: Origin` keeps a shared cache from serving this allow-header to a different origin.
      // Belt and braces alongside `cache-control: no-store`, which some intermediaries ignore.
      reply.header("access-control-allow-origin", allowed).header("vary", "Origin");
    });
  },
  { name: "mandate-origin-guard" },
);
