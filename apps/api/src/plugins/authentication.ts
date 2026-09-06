import type { Authenticator } from "@mandate/auth";
import { Problem } from "@mandate/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { plugin } from "./plugin.js";
import type { Principal } from "./types.js";

/** Resolves a verified Privy DID to the local user row. Narrower than the full Repository. */
export interface PrivyUserDirectory {
  resolvePrivyUser(did: string): Promise<{ id: string }>;
}

export interface AuthenticationOptions {
  readonly auth: Authenticator;
  readonly users: PrivyUserDirectory;
  /** Exact `/v1` paths served without a bearer token. Prefix matching is not used. */
  readonly publicPaths?: readonly string[] | undefined;
}

/**
 * The `/v1` routes that serve anonymous callers: the asset catalogue with its observed feeds,
 * and price history. Both are read-only market data that the landing page shows before anyone
 * connects a wallet — asking for a wallet to see a chart demands a commitment before showing
 * anything worth committing to.
 *
 * These are EXACT paths, not prefixes. `/v1/market/quote` is deliberately absent: a quote costs
 * RPC calls, is gated on eligibility, and is a step toward trading rather than a way to look.
 * Candles cost an upstream call too, but a cached one shared by every viewer, and the route
 * carries its own tighter rate limit.
 */
export const DEFAULT_PUBLIC_PATHS: readonly string[] = ["/v1/market", "/v1/market/candles"];

/** Base used only to give `new URL` something to resolve against; never contacted. */
const PARSE_BASE = "http://request.invalid";

/**
 * Does this request URL need a verified bearer token?
 *
 * Exported for direct testing because it is the security boundary: everything under `/v1/` is
 * protected unless explicitly allowlisted.
 *
 * The subtlety is that `request.url` is not always a path. Node's HTTP parser accepts an
 * absolute-form request line (`GET http://host/v1/me HTTP/1.1`, RFC 9112 §3.2.2, which origin
 * servers must accept) and hands it through verbatim — verified against a real listening
 * fastify server on this workspace's fastify 5.12.3, where `request.url` came back as
 * `"http://127.0.0.1:58417/v1/me"` while find-my-way still routed it to the `/v1/me` handler.
 * A naive `url.startsWith("/v1/")` therefore skips authentication entirely for that form.
 * Today the routes happen to fail closed a second time by dereferencing `request.principal`,
 * so this is a latent hole rather than a live one — but the gate is supposed to BE the
 * boundary, and the next route that forgets that call would be silently public.
 *
 * Both forms are tested and the check fails closed: if either the raw path or the parsed
 * pathname looks like a protected `/v1` path, the token is required. Matching only the parsed
 * pathname would open the opposite hole, since `GET //v1/me` parses as pathname `/me`.
 */
export function protectedRequest(url: string, publicPaths: readonly string[]): boolean {
  const candidates = new Set<string>([url.split("?", 1)[0] ?? ""]);
  try {
    candidates.add(new URL(url, PARSE_BASE).pathname);
  } catch {
    // Unparseable target: the raw candidate above still decides, and it decides closed.
  }
  for (const path of candidates)
    if (path.startsWith("/v1/") && !publicPaths.includes(path)) return true;
  return false;
}

/**
 * Verifies the Privy bearer token and attaches the resolved principal.
 *
 * There is intentionally no try/catch around `authenticate`. `PrivyAuthenticator` already draws
 * the distinction that matters: 401 for a missing, malformed, expired, forged or
 * wrong-app token, and 503 when Privy itself could not be reached. Re-wrapping everything as
 * 401 would tell every signed-in user their session had been revoked during a provider blip,
 * and they would all re-authenticate against the provider that is already down.
 *
 * Nothing here is logged. The hook holds the raw `Authorization` header, and SDK errors from a
 * failed verification can carry the submitted token in their body. pino's redact list covers
 * `req.headers.authorization` but not an error passed as a log field, so the safe rule is that
 * this plugin logs nothing at all and the app-level error handler reports only `{ code }`.
 */
export const authentication: FastifyPluginAsync<AuthenticationOptions> = plugin(
  async (app, options) => {
    const publicPaths = options.publicPaths ?? DEFAULT_PUBLIC_PATHS;
    // Guarded: app.ts may still decorate during the handoff. Default is null, so a route that
    // forgets `requirePrincipal` reads "no identity" rather than inheriting a previous one.
    if (!app.hasRequestDecorator("principal")) app.decorateRequest("principal", null);

    app.addHook("onRequest", async (request) => {
      // A preflight carries no Authorization header by definition — the browser sends it only
      // on the real request. Answering 401 here breaks CORS for every authenticated route.
      if (request.method === "OPTIONS") return;
      if (!protectedRequest(request.url, publicPaths)) return;
      const authenticated = await options.auth.authenticate(request.headers.authorization);
      const user = await options.users.resolvePrivyUser(authenticated.privyDid);
      request.principal = { ...authenticated, user: user.id };
    });
  },
  { name: "mandate-authentication" },
);

/**
 * Reads the principal a route requires, or fails closed.
 *
 * Routes call this rather than reading `request.principal` directly so that a public route
 * accidentally moved under `/v1/` cannot quietly serve `null` as an owner id.
 */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw Problem.unauthenticated();
  return request.principal;
}
