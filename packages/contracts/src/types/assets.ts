import type { AssetSymbol, DecimalString, Hex } from "./primitives.js";

/**
 * A tradable asset: the token, the independent reference feed, and the scale.
 *
 * All four fields travel together on purpose. `token` without `decimals` is unusable — every
 * B20 equity on Base has 8 decimals and nothing in this market has 18, so an address carried
 * around without its scale invites the 1e10 mispricing. `feed` travels with it because a
 * venue price this system will act on is only ever accepted after it has been checked against
 * the Chainlink reference for that exact asset; an asset with no reference is not tradable.
 *
 * Byte-identical to the declarations in src/index.ts and in @mandate/strategy's strategy.ts,
 * which today are two independent copies of one shape. Identical structural types are mutually
 * assignable, so all three coexist; this is the one that should survive, and the others should
 * become re-exports of it.
 */
export type Asset = {
  symbol: AssetSymbol;
  token: Hex;
  /** The Chainlink aggregator. Total-return: the split and dividend multiplier is already in
   * the answer, so applying one again double-counts. */
  feed: Hex;
  /** The token's own scale, from the catalogue. Never assumed. */
  decimals: number;
};

/** The catalogue as it is handed around: read-only, because nothing downstream may edit it. */
export type AssetCatalogue = readonly Asset[];

/**
 * The independent reference reading for an asset, from its Chainlink aggregator.
 *
 * Keyed by symbol rather than by feed address so a caller that only knows what the user typed
 * can find it. These feeds are deviation-or-heartbeat driven and hold the last close when the
 * equity market is shut, so a reading many hours old is normal operation — a weekend is ~64h —
 * and staleness is a 26h question, not a 5-minute one.
 */
export type OracleFeedUri = `oracle:${AssetSymbol}`;

/** The venue's own price for the same asset, observed from a quoter probe. */
export type DexFeedUri = `dex:${AssetSymbol}`;

/**
 * Every key a strategy may reference as a feed.
 *
 * A template literal type rather than a plain string: `validatePlan` builds the legal set as
 * `dex:<symbol>` and `oracle:<symbol>` for each asset in the envelope and rejects anything
 * else, so a typed key catches at compile time the same mistake the validator catches at parse
 * time. The prefix is what distinguishes the two independent observations of one asset, and
 * confusing them is how a venue price ends up validated against itself.
 */
export type FeedUri = OracleFeedUri | DexFeedUri;

/**
 * The feed values one evaluation ran against, exactly as they are persisted to
 * `evaluations.inputs`.
 *
 * Decimal strings, never numbers, and the record is the audit trail: it is what lets a user be
 * shown why a rule did or did not fire on a tick that has long since passed. Keys are
 * `FeedUri`s, but the type is a plain string record because that is what is read back out of
 * a jsonb column, where nothing enforces the prefix.
 */
export type FeedValues = Record<string, DecimalString>;
