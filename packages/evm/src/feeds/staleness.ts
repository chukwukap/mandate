import { Problem } from "@mandate/contracts";
import { formatUnits } from "viem";

/**
 * Chainlink publishes a new round when the price moves past a deviation threshold OR when
 * the heartbeat expires. It does not publish because a market is open. The Coinbase B20
 * equity feeds on Base carry a 24h heartbeat, so a quiet overnight, a weekend, or simply a
 * flat hour legitimately produces an answer that is many hours old and completely valid.
 */
export const FEED_HEARTBEAT_SECONDS = 24 * 3600;

/**
 * Slack on top of the heartbeat. A heartbeat round is submitted *at* the deadline, then
 * has to be mined and then read through a public RPC, so an answer that is a little over
 * 24h old is normal operation, not a fault. Two hours absorbs that without letting a
 * genuinely abandoned feed through.
 */
export const FEED_HEARTBEAT_SLACK_SECONDS = 2 * 3600;

/**
 * 26h. This is the number the API contract publishes ("references older than 26 hours
 * cannot support a quote") and it is deliberately far above any trading-session bound.
 *
 * A staleness rule tuned to market hours is the failure to avoid here: the worker's
 * `authorize()` currently refuses on `now - updatedAt > 300`, and because these feeds are
 * deviation-or-heartbeat driven, five minutes rejects essentially every automatic order
 * outside a price-moving event — nightly, weekends, and any quiet hour. Whether the market
 * is open is a separate policy decision (see `executionSession`), and it must be decided on
 * its own terms rather than smuggled in as a freshness check.
 */
export const MAX_FEED_AGE_SECONDS = FEED_HEARTBEAT_SECONDS + FEED_HEARTBEAT_SLACK_SECONDS;

/**
 * Tolerated clock skew between this process and the chain. A node clock a few seconds
 * behind makes a brand new round look future-dated; beyond a minute, a future `updatedAt`
 * is a corrupted or rogue aggregator, and must never be read as "maximally fresh".
 */
export const MAX_FEED_SKEW_SECONDS = 60;

/** Above this, `formatUnits` output is unusable as a price and the feed is not what we think. */
const MAX_FEED_DECIMALS = 36;

export type FeedRound = {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
};

export type FeedReading = {
  /** Decimal string, already scaled by the feed's own `decimals()`. Never a float. */
  value: string;
  answer: bigint;
  decimals: number;
  roundId: bigint;
  /** Unix seconds. */
  updatedAt: number;
  ageSeconds: number;
  maxAgeSeconds: number;
  stale: boolean;
};

/** Name the tuple positions once, here, instead of at every `round[3]` call site. */
export function toFeedRound(
  tuple: readonly [bigint, bigint, bigint, bigint, bigint] | readonly bigint[],
): FeedRound {
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = tuple;
  if (
    roundId === undefined ||
    answer === undefined ||
    startedAt === undefined ||
    updatedAt === undefined ||
    answeredInRound === undefined
  )
    throw Problem.unavailable("The reference feed returned an incomplete round.");
  return { roundId, answer, startedAt, updatedAt, answeredInRound };
}

/**
 * Validate a round's structure and measure its age. Structural faults throw — they mean the
 * aggregator is not answering sanely and no amount of retrying makes the number usable.
 * Age is reported as `stale` rather than thrown, so callers that publish an observation
 * (market feeds are surfaced with `stale: true`) and callers that must refuse to act
 * (`requireFresh`) can share one code path.
 */
export function assessRound(params: {
  round: FeedRound;
  decimals: number;
  nowSeconds: number;
  maxAgeSeconds?: number;
}): FeedReading {
  const { round, decimals, nowSeconds } = params;
  const maxAgeSeconds = params.maxAgeSeconds ?? MAX_FEED_AGE_SECONDS;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_FEED_DECIMALS)
    throw Problem.unavailable("The reference feed reported an unusable decimal scale.");
  if (!Number.isFinite(nowSeconds) || nowSeconds <= 0)
    throw new Problem(
      500,
      "invalid-clock",
      "Invalid clock",
      "The local clock is not usable for a freshness check.",
    );
  // A non-positive answer is an aggregator fault, not a cheap asset. Quoting against it
  // would divide by zero or invert the trade direction.
  if (round.answer <= 0n)
    throw Problem.unavailable("The reference feed reported a non-positive price.");
  // updatedAt == 0 means the round was never answered. Treating it as a timestamp would
  // compute an age of `now` and, on a slow enough bound, pass.
  if (round.updatedAt <= 0n)
    throw Problem.unavailable("The reference feed reported an unanswered round.");
  if (round.roundId <= 0n)
    throw Problem.unavailable("The reference feed reported an invalid round id.");
  const now = Math.floor(nowSeconds);
  if (round.updatedAt > BigInt(now + MAX_FEED_SKEW_SECONDS))
    throw Problem.unavailable("The reference feed reported a future timestamp.");
  // answeredInRound < roundId is close to meaningless on OCR2 aggregators, where it is
  // simply set equal to roundId. Kept because it costs nothing and still catches a legacy
  // carried-over answer; `updatedAt` is what actually protects the system.
  if (round.answeredInRound < round.roundId)
    throw Problem.unavailable("The reference feed reported a carried-over answer.");
  const updatedAt = Number(round.updatedAt);
  // Clamp at zero: within the tolerated skew a future timestamp is "just published",
  // not "negatively old".
  const ageSeconds = Math.max(0, now - updatedAt);
  return {
    value: formatUnits(round.answer, decimals),
    answer: round.answer,
    decimals,
    roundId: round.roundId,
    updatedAt,
    ageSeconds,
    maxAgeSeconds,
    stale: ageSeconds > maxAgeSeconds,
  };
}

/** Refuse to act on a stale answer. Returns the reading so it can be used inline. */
export function requireFresh(reading: FeedReading): FeedReading {
  if (reading.stale)
    throw Problem.unavailable(
      `The reference price is ${reading.ageSeconds}s old, past the ${reading.maxAgeSeconds}s bound.`,
    );
  return reading;
}
