import type { Hex } from "../../../packages/contracts/src/index.js";
import {
  assessRound,
  type FeedReading,
  type FeedRound,
  MAX_FEED_AGE_SECONDS,
} from "../../../packages/evm/src/feeds/staleness.js";
import { assetOf, B20_ASSETS, FEED_DECIMALS } from "./catalogue.js";

/**
 * Recorded Chainlink AggregatorV3 answers, fresh and stale.
 *
 * Two properties of these feeds drive everything here, and both are counter-intuitive:
 *
 * 1. They are TOTAL RETURN feeds. The split and dividend multiplier is already inside the
 *    answer. Applying the token's own multiplier on top double-counts it, and the result is
 *    not a rounding error: a 10:1 split moves the reference an order of magnitude, so the
 *    honest pool reads ~9,000 bps away from it and every order on a healthy market is
 *    refused. See `NVDA_SPLIT_MULTIPLIER`.
 * 2. They have no heartbeat while equity markets are shut; the aggregator simply holds the
 *    last close. The AAPL feed was measured 15.07h stale on a weekday evening, and a weekend
 *    reaches ~64h. A staleness constant chosen for a 24/7 asset therefore halts trading every
 *    single weekend on tokens that trade 24/7. `WEEKEND` exists so that behaviour is pinned by
 *    a test instead of discovered on a Saturday.
 */

/** Named clocks. Fixed instants so nothing here depends on when the suite runs. */
export const CLOCKS = {
  /** Thu 3 Sep 2026, 13:00 America/New_York — inside the regular US session. */
  tradingHours: 1_788_454_800_000,
  /** Thu 3 Sep 2026, 18:30 America/New_York — after the close, same weekday. */
  weekdayEvening: 1_788_474_600_000,
  /** Sun 6 Sep 2026, 20:30 America/New_York — the middle of a closed weekend. */
  weekend: 1_788_741_000_000,
} as const;

/** Ages in seconds. `weekdayEvening` and `weekend` are the two measured off-hours cases. */
export const AGES = {
  /** A round published a moment ago, well inside any bound. */
  fresh: 42,
  /** 15.07h — the AAPL feed as measured on a weekday evening. */
  weekdayEvening: 54_252,
  /** 64h — a full weekend of held close. Past the 26h bound `packages/evm` enforces. */
  weekend: 230_400,
  /** Exactly on the 26h bound. `stale` is `age > max`, so this one is still usable. */
  atBound: MAX_FEED_AGE_SECONDS,
  /** One second past the bound: the first age that refuses a quote. */
  pastBound: MAX_FEED_AGE_SECONDS + 1,
} as const;

/**
 * Reference prices in USD, at the feed's own 8 decimals.
 *
 * AAPLc's 320.08 is the measured NAV the venue fixtures are checked against; the rest are
 * fixture-chosen round numbers in a plausible range. Nothing may treat these as market data —
 * they exist to make deviations arithmetically checkable.
 */
export const NAV_USD: Readonly<Record<string, string>> = {
  AAPLc: "320.08",
  GOOGLc: "241.5",
  METAc: "612.4",
  NVDAc: "177.85",
  MSFTc: "428.6",
  AMZNc: "231.75",
  TSLAc: "440.55",
};

/**
 * The fixture NAV for a symbol, or a thrown error naming the symbol.
 *
 * NAV_USD is keyed by string so the fixture builders can look up whatever asset they are handed,
 * which makes every read `string | undefined`. A test comparing against a symbol it just named
 * should not have to defend against a case that cannot happen — and should not paper over it with
 * a non-null assertion either, because the day someone renames a fixture symbol, the assertion
 * turns a clear failure into a comparison against undefined.
 */
export function navFor(symbol: string): string {
  const value = NAV_USD[symbol];
  if (value === undefined) throw new Error(`No fixture NAV for ${symbol}`);
  return value;
}

/** A recorded `latestRoundData()` tuple, already named. */
export type RecordedRound = FeedRound;

export type FeedFixture = {
  readonly id: string;
  readonly symbol: string;
  readonly feed: Hex;
  readonly decimals: number;
  readonly round: RecordedRound;
  /** The clock this round was read at, in ms. Age is `observedAt/1000 - round.updatedAt`. */
  readonly observedAt: number;
  /** Why this fixture exists. Read by nothing; written for whoever debugs the failure. */
  readonly note: string;
};

/** Decimal USD string to the feed's integer answer. Exact: a power-of-ten shift, no floats. */
export function answerOf(price: string, decimals = FEED_DECIMALS): bigint {
  const [whole = "0", fraction = ""] = price.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals)
    throw new Error(`Price ${price} is not representable at ${decimals} decimals`);
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/**
 * Build a well-formed round of a given age.
 *
 * `startedAt` trails `updatedAt` by a second and `answeredInRound` equals `roundId`, which is
 * what OCR2 aggregators actually publish. Faults are produced by overriding one field at a
 * time, so a test that breaks a round breaks exactly the field it names.
 */
export function roundAt(params: {
  price: string;
  observedAt: number;
  ageSeconds: number;
  roundId?: bigint;
  decimals?: number;
  overrides?: Partial<RecordedRound>;
}): RecordedRound {
  const updatedAt = BigInt(Math.floor(params.observedAt / 1000) - params.ageSeconds);
  const roundId = params.roundId ?? 18_446_744_073_709_562_000n;
  return {
    roundId,
    answer: answerOf(params.price, params.decimals ?? FEED_DECIMALS),
    startedAt: updatedAt - 1n,
    updatedAt,
    answeredInRound: roundId,
    ...params.overrides,
  };
}

function feedFixture(params: {
  id: string;
  symbol: string;
  observedAt: number;
  ageSeconds: number;
  note: string;
  overrides?: Partial<RecordedRound>;
  price?: string;
}): FeedFixture {
  const asset = assetOf(params.symbol);
  const price = params.price ?? NAV_USD[params.symbol];
  if (price === undefined) throw new Error(`No fixture NAV for ${params.symbol}`);
  return {
    id: params.id,
    symbol: params.symbol,
    feed: asset.feed,
    decimals: FEED_DECIMALS,
    round: roundAt({
      price,
      observedAt: params.observedAt,
      ageSeconds: params.ageSeconds,
      ...(params.overrides ? { overrides: params.overrides } : {}),
    }),
    observedAt: params.observedAt,
    note: params.note,
  };
}

/**
 * NVDAc's total-return trap.
 *
 * NVDA split 10:1. The feed answer below is $177.85 and that number is ALREADY post-split;
 * the venue quotes $177.86 against it, 0.56 bps out. A consumer that reads the token's split
 * multiplier and applies it again gets a $1,778.50 reference, against which the honest pool
 * sits ~8,999 bps low — 18x the sanity band — so every order on a healthy market is refused.
 * The multiplier is recorded here so a test can demonstrate the double count, not describe it.
 */
export const NVDA_SPLIT_MULTIPLIER = 10n;

export const FEEDS: readonly FeedFixture[] = [
  feedFixture({
    id: "aaplc-fresh",
    symbol: "AAPLc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: AGES.fresh,
    note: "Regular session, 42s old. The baseline every quote fixture is checked against.",
  }),
  feedFixture({
    id: "aaplc-weekday-evening",
    symbol: "AAPLc",
    observedAt: CLOCKS.weekdayEvening,
    ageSeconds: AGES.weekdayEvening,
    note: "15.07h old, measured after a weekday close. Inside the 26h bound, so still usable — the case a five-minute freshness rule would wrongly refuse.",
  }),
  feedFixture({
    id: "aaplc-weekend",
    symbol: "AAPLc",
    observedAt: CLOCKS.weekend,
    ageSeconds: AGES.weekend,
    note: "64h old. Past the 26h bound, so every quote is refused for the whole weekend even though the token itself trades 24/7.",
  }),
  feedFixture({
    id: "aaplc-at-bound",
    symbol: "AAPLc",
    observedAt: CLOCKS.weekdayEvening,
    ageSeconds: AGES.atBound,
    note: "Exactly 26h. `stale` is a strict `>`, so this is the oldest round that still supports a quote.",
  }),
  feedFixture({
    id: "aaplc-past-bound",
    symbol: "AAPLc",
    observedAt: CLOCKS.weekdayEvening,
    ageSeconds: AGES.pastBound,
    note: "26h + 1s. The first age that refuses.",
  }),
  feedFixture({
    id: "nvdac-total-return",
    symbol: "NVDAc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: AGES.fresh,
    note: "Post-split total-return answer. Applying NVDA_SPLIT_MULTIPLIER again double-counts the split and puts the honest venue ~8,999 bps away from its own reference.",
  }),
  feedFixture({
    id: "googlc-fresh",
    symbol: "GOOGLc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: AGES.fresh,
    note: "A second healthy asset, so multi-asset snapshots are not a single feed repeated.",
  }),
  feedFixture({
    id: "msftc-fresh",
    symbol: "MSFTc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: AGES.fresh,
    note: "A perfectly good reference for a token with no route. Proves 'no quote' and 'no reference' are different failures.",
  }),
  feedFixture({
    id: "aaplc-zero-answer",
    symbol: "AAPLc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: AGES.fresh,
    overrides: { answer: 0n },
    note: "A zero answer is an aggregator fault, not a free share. Dividing by it would invert or explode every price.",
  }),
  feedFixture({
    id: "aaplc-unanswered",
    symbol: "AAPLc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: AGES.fresh,
    overrides: { updatedAt: 0n, startedAt: 0n },
    note: "updatedAt == 0 means the round was never answered. Read as a timestamp it would compute an age of `now` and pass a loose bound.",
  }),
  feedFixture({
    id: "aaplc-future",
    symbol: "AAPLc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: -120,
    note: "Two minutes in the future, past the 60s skew tolerance. A future timestamp must not read as maximally fresh.",
  }),
  feedFixture({
    id: "aaplc-carried-over",
    symbol: "AAPLc",
    observedAt: CLOCKS.tradingHours,
    ageSeconds: AGES.fresh,
    overrides: { answeredInRound: 18_446_744_073_709_561_000n },
    note: "answeredInRound < roundId: a legacy aggregator carrying an older answer forward.",
  }),
];

export function feedOf(id: string): FeedFixture {
  const fixture = FEEDS.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`No feed fixture ${id}`);
  return fixture;
}

/**
 * Run a recorded round through the real staleness assessment.
 *
 * Deliberately the production function: a fixture that computed its own age would keep
 * reporting "fresh" after `assessRound` changed its mind, which is the failure a fixture is
 * supposed to prevent rather than cause. Structural faults throw here, exactly as they do in
 * `ChainlinkFeeds.read`.
 */
export function readingOf(fixture: FeedFixture, atMs = fixture.observedAt): FeedReading {
  return assessRound({
    round: fixture.round,
    decimals: fixture.decimals,
    nowSeconds: Math.floor(atMs / 1000),
  });
}

/**
 * One round per catalogue asset, all the same age.
 *
 * This is what the fake chain client is fed: a whole market observed at one instant. Pass
 * `overrides` keyed by symbol to break exactly one feed and leave the rest healthy — the
 * per-feed isolation `ChainlinkFeeds.readMany` promises is only testable that way.
 */
export function marketRounds(params: {
  observedAt: number;
  ageSeconds?: number;
  overrides?: Readonly<Record<string, RecordedRound>>;
}): Map<string, RecordedRound> {
  const ageSeconds = params.ageSeconds ?? AGES.fresh;
  const rounds = new Map<string, RecordedRound>();
  for (const asset of B20_ASSETS) {
    const override = params.overrides?.[asset.symbol];
    const price = NAV_USD[asset.symbol];
    if (price === undefined) throw new Error(`No fixture NAV for ${asset.symbol}`);
    rounds.set(
      asset.feed.toLowerCase(),
      override ?? roundAt({ price, observedAt: params.observedAt, ageSeconds }),
    );
  }
  return rounds;
}
