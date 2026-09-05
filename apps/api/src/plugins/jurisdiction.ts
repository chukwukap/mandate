import { eligible, jurisdiction } from "@mandate/auth";
import { Problem } from "@mandate/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { plugin } from "./plugin.js";

export interface JurisdictionOptions {
  /** Exact IPs of the proxies permitted to assert `cf-ipcountry`. Empty means "trust nobody". */
  readonly trustedProxyIps: readonly string[];
  /** Countries the product is offered in. `US` and `XX` are rejected by config validation. */
  readonly eligibleCountries: readonly string[];
  /** Non-production override so a developer can exercise the eligible path locally. */
  readonly devCountry?: string | undefined;
  readonly production: boolean;
}

/**
 * Derives `request.jurisdiction` and `request.eligible` for every non-preflight request.
 *
 * The country is only ever read from `cf-ipcountry`, and only when the *socket* peer is one of
 * the exact IPs in TRUSTED_PROXY_IPS. The server runs with `trustProxy: false`, so `request.ip`
 * is the real peer and cannot be moved by `x-forwarded-for`. A direct client that invents
 * `cf-ipcountry: GB` is ignored and lands on `XX`, which `eligible()` never accepts. This is a
 * product allowlist, not a KYC attestation, and the deny-by-default direction is the whole
 * value of it.
 *
 * OPTIONS returns early. A preflight carries no credential and no meaningful client IP
 * semantics, and the browser will not surface a 403 on it as anything an operator can debug —
 * it just reports "CORS failed" and the real request never happens.
 */
export const jurisdictionPolicy: FastifyPluginAsync<JurisdictionOptions> = plugin(
  async (app, options) => {
    // Guarded because app.ts may still carry its own decoration during the handoff; a second
    // unguarded `decorateRequest` for the same key is FST_ERR_DEC_ALREADY_PRESENT at boot.
    // The defaults are the closed ones: unknown country, not eligible.
    if (!app.hasRequestDecorator("jurisdiction")) app.decorateRequest("jurisdiction", "XX");
    if (!app.hasRequestDecorator("eligible")) app.decorateRequest("eligible", false);

    app.addHook("onRequest", async (request) => {
      if (request.method === "OPTIONS") return;
      const header = request.headers["cf-ipcountry"];
      request.jurisdiction = jurisdiction({
        remoteIp: request.ip,
        countryHeader: typeof header === "string" ? header : undefined,
        trustedProxyIps: options.trustedProxyIps,
        devCountry: options.devCountry,
        production: options.production,
      });
      request.eligible = eligible(request.jurisdiction, options.eligibleCountries);
    });
  },
  { name: "mandate-jurisdiction" },
);

/**
 * Gate for anything that moves money or commits a strategy.
 *
 * Separate from authentication on purpose: a signed-in user in an unsupported jurisdiction can
 * still read their own account, they just cannot trade. Wording matches the copy already used
 * in the strategies module so the two cannot drift apart into two different 403s.
 */
export function requireEligible(request: FastifyRequest): void {
  if (!request.eligible)
    throw new Problem(
      403,
      "not-eligible",
      "Trading unavailable",
      "Trading is unavailable for your verified jurisdiction.",
    );
}
