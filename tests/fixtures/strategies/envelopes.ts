import type { Asset as WireAsset } from "../../../packages/contracts/src/index.js";
import type { Caps, Envelope } from "../../../packages/strategy/src/validation/schema.js";
import { capsSchema } from "../../../packages/strategy/src/validation/schema.js";
import { assetOf, CLOCKS, plainAsset, USDC } from "../chain/index.js";

/**
 * Signed spend envelopes for the strategy fixtures.
 *
 * The envelope is the authority: the plan says what to do, the envelope says how much of the
 * user's money it may ever move. Everything here is authored as a decimal string and parsed
 * through the production `capsSchema`, so a fixture cannot express caps the user could not
 * have signed — an unordered per-order/per-period/lifetime triple, or a cap with more than
 * USDC's six decimal places, fails to build rather than failing later at tick time.
 */

/** The instant every strategy fixture is anchored to: Thu 3 Sep 2026, 13:00 America/New_York. */
export const T0 = CLOCKS.tradingHours;
export const DAY_MS = 86_400_000;

/**
 * The signed allowlist: one asset the venue can fill, one it cannot.
 *
 * Order matters and is load-bearing. Plan actions address assets by INDEX into this array, so
 * index 0 is the tradable AAPLc and index 1 the untradable MSFTc — a real, deployed B20
 * equity with a live Chainlink feed and no Aerodrome pool this system routes. Reordering these
 * silently retargets every order in every fixture, which is exactly the failure
 * `resolveAsset` exists to make impossible on a signed strategy.
 */
export const SIGNED_ASSETS: readonly WireAsset[] = [
  plainAsset(assetOf("AAPLc")),
  plainAsset(assetOf("MSFTc")),
];

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

export function caps(overrides: Partial<Record<keyof Caps, unknown>> = {}): Caps {
  return capsSchema.parse({
    lifetime: "5000",
    per_order: "250",
    per_period: "1000",
    period_secs: 86_400,
    max_orders_per_period: 10,
    cooldown_secs: 0,
    expires_at: isoAt(T0 + 30 * DAY_MS),
    slippage_bps: 50,
    ...overrides,
  });
}

export function envelope(overrides: { caps?: Caps; assets?: readonly WireAsset[] } = {}): Envelope {
  return {
    version: "mandate/2",
    caps: overrides.caps ?? caps(),
    // Copied, not aliased: `Envelope.assets` is mutable, and a fixture that handed out its
    // own array would let one test's mutation retarget every later test's order indices.
    assets: [...(overrides.assets ?? SIGNED_ASSETS)],
    quote: USDC,
    venue: "aerodrome",
  };
}

/** Room for everything the fixtures do. Use it when the envelope is not what is under test. */
export const STANDARD_ENVELOPE = envelope();

/**
 * Deliberately narrow: two 250 USDC orders fit the per-order cap individually and only the
 * first fits the 300 USDC period cap. That is the case a naive implementation gets wrong,
 * because the second order is only refused if the first one's reservation is visible inside
 * the same tick.
 */
export const TIGHT_ENVELOPE = envelope({
  caps: caps({ lifetime: "1000", per_order: "250", per_period: "300" }),
});

/** Already past its `expires_at` at `T0`. The permission may still be live; the mandate is not. */
export const EXPIRED_ENVELOPE = envelope({
  caps: caps({ expires_at: isoAt(T0 - 3_600_000) }),
});
