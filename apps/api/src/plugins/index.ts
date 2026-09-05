import type { Config } from "@mandate/config";
import type { FastifyInstance } from "fastify";
import { type AuthenticationOptions, authentication } from "./authentication.js";
import { requestContext } from "./context.js";
import { originGuard } from "./cors.js";
import { jurisdictionPolicy } from "./jurisdiction.js";

export interface PluginOptions {
  readonly config: Config;
  readonly auth: AuthenticationOptions["auth"];
  readonly users: AuthenticationOptions["users"];
  /** Overrides the anonymous `/v1` allowlist. Pass exact paths, never prefixes. */
  readonly publicPaths?: readonly string[] | undefined;
}

/**
 * Registers the request pipeline in the one order that is correct.
 *
 * This exists as a single function rather than four `app.register` calls in app.ts because the
 * order is load-bearing and inverting it fails silently — with a 200 test suite, not a boot
 * error. Fastify runs root `onRequest` hooks in registration order, and every plugin here skips
 * encapsulation, so each one appends to the root hook array in the order it is registered:
 *
 *   1. requestContext    — correlation id and `no-store` land on every response, including the
 *                          403 and 401 produced by the two hooks after it.
 *   2. originGuard       — a cross-origin request is rejected BEFORE its token is examined.
 *                          Registering authentication first turns "attacker origin with a valid
 *                          bearer" from 403 into 401, and turns an unauthenticated cross-origin
 *                          probe into a Privy round trip an attacker can trigger for free.
 *   3. jurisdictionPolicy— `eligible` must be set before any route reads it, and it is derived
 *                          for anonymous callers too so a public route can still branch on it.
 *   4. authentication    — last, so it only runs for requests that already passed the guards.
 *
 * Call this before registering any route: the plugins decorate `FastifyRequest`, and fastify
 * requires decorators to exist before the routes that reference them are built.
 */
export async function registerPlugins(app: FastifyInstance, options: PluginOptions): Promise<void> {
  const { config } = options;
  await app.register(requestContext);
  await app.register(originGuard, { origin: config.origin });
  await app.register(jurisdictionPolicy, {
    trustedProxyIps: config.trustedProxyIps,
    eligibleCountries: config.eligibleCountries,
    devCountry: config.devCountry,
    production: config.env === "production",
  });
  await app.register(authentication, {
    auth: options.auth,
    users: options.users,
    ...(options.publicPaths ? { publicPaths: options.publicPaths } : {}),
  });
}

export type { AuthenticationOptions, PrivyUserDirectory } from "./authentication.js";
export {
  authentication,
  DEFAULT_PUBLIC_PATHS,
  protectedRequest,
  requirePrincipal,
} from "./authentication.js";
export { requestContext } from "./context.js";
export type { OriginOptions } from "./cors.js";
export { originGuard, PREFLIGHT_HEADERS, PREFLIGHT_METHODS } from "./cors.js";
export type { JurisdictionOptions } from "./jurisdiction.js";
export { jurisdictionPolicy, requireEligible } from "./jurisdiction.js";
export type { PluginMeta } from "./plugin.js";
export { plugin } from "./plugin.js";
export type { Principal } from "./types.js";
