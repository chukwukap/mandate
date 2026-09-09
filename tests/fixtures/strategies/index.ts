/**
 * A library of authored strategies covering the cases that are worth a test: a simple
 * conditional buy, one that trips its signed envelope, one past its own expiry, one pointed at
 * an asset no pool can fill, an edge-triggered rule that must fire once rather than every
 * tick, and two that must fail validation with something a user can act on.
 *
 * Each fixture is data plus the outcome it expects, and `strategies.test.ts` proves the
 * expectation against the real validator and tick. Deep relative imports rather
 * than `@mandate/*`: `tests/` has no `node_modules`, so a bare workspace specifier does not
 * resolve from here.
 */
export type { Caps, Envelope } from "../../../packages/strategy/src/validation/schema.js";
export {
  caps,
  DAY_MS,
  EXPIRED_ENVELOPE,
  envelope,
  isoAt,
  SIGNED_ASSETS,
  STANDARD_ENVELOPE,
  T0,
  TIGHT_ENVELOPE,
} from "./envelopes.js";
export {
  CONDITIONAL_BUY,
  EDGE_TRIGGERED,
  ENVELOPE_TRIPPER,
  LEVEL_TRIGGERED,
  MALFORMED_SCHEMA,
  MALFORMED_SEMANTICS,
  UNTRADABLE_ASSET,
} from "./plans.js";
export type { Expectation, Replay, StrategyFixture, TickInput } from "./scenarios.js";
export {
  observation,
  planOf,
  portfolio,
  replay,
  STRATEGIES,
  strategyOf,
} from "./scenarios.js";
