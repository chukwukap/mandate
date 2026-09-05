import type { Asset, Hex, MarketFeed } from "@mandate/contracts";
import { Problem } from "@mandate/contracts";
import type { Chain, PublicClient, Transport } from "viem";
import { aggregatorV3Abi } from "../abis/index.js";
import {
  assessRound,
  type FeedReading,
  MAX_FEED_AGE_SECONDS,
  requireFresh,
  toFeedRound,
} from "./staleness.js";

/**
 * The read surface this module needs. Injected, never constructed here.
 *
 * The chain is a type parameter rather than a fixed `Chain`: viem threads the chain
 * through action parameter types, which makes `PublicClient<Transport, Chain>` invariant,
 * so a concrete `PublicClient<Transport, typeof base>` — what `BaseReader` and the worker
 * both hold — would not be assignable to it.
 */
export type FeedClient<chain extends Chain | undefined = Chain | undefined> = PublicClient<
  Transport,
  chain
>;

export type ChainlinkOptions = {
  /** Override the 26h bound. Only ever widen it deliberately; see staleness.ts. */
  maxAgeSeconds?: number;
  /** Injectable clock (ms since epoch) so freshness is testable without waiting a day. */
  now?: () => number;
};

/** Why a feed could not be read. Deliberately coarse: no upstream text ever escapes. */
export type FeedFailure = "unreachable" | "invalid";

export type FeedBatch = {
  /** Readable feeds, keyed by lowercased address. May contain stale readings. */
  readings: Map<string, FeedReading>;
  /** Feeds that produced nothing usable. */
  unavailable: Map<string, FeedFailure>;
};

/**
 * Reads Chainlink AggregatorV3 feeds with an explicit staleness bound.
 *
 * Failure policy: every RPC or decode failure becomes a 503 Problem with a fixed message.
 * The upstream error object is discarded rather than forwarded — provider errors routinely
 * echo the request URL, which carries the API key.
 */
export class ChainlinkFeeds<chain extends Chain | undefined = Chain | undefined> {
  /**
   * `decimals()` is immutable in practice: it is part of the feed's published interface and
   * every consumer's price math depends on it, so Chainlink does not change it across
   * aggregator upgrades behind a proxy. Cached for the process lifetime, and only after a
   * value that passed the sanity bound — caching a bad read once would scale every
   * subsequent price by a power of ten.
   */
  private readonly decimalsCache = new Map<string, number>();
  private readonly maxAgeSeconds: number;
  private readonly now: () => number;

  constructor(
    private readonly client: FeedClient<chain>,
    options: ChainlinkOptions = {},
  ) {
    this.maxAgeSeconds = options.maxAgeSeconds ?? MAX_FEED_AGE_SECONDS;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxAgeSeconds) || this.maxAgeSeconds <= 0)
      throw new Error("ChainlinkFeeds requires a positive integer staleness bound");
  }

  private nowSeconds() {
    return Math.floor(this.now() / 1000);
  }

  private async decimalsOf(feed: Hex): Promise<number> {
    const key = feed.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;
    const decimals = await this.client.readContract({
      address: feed,
      abi: aggregatorV3Abi,
      functionName: "decimals",
    });
    // Validated before caching. assessRound re-checks, but a poisoned cache would
    // outlive the request that poisoned it.
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
      throw Problem.unavailable("The reference feed reported an unusable decimal scale.");
    this.decimalsCache.set(key, decimals);
    return decimals;
  }

  /**
   * The one place a feed is actually read. Returns the failure instead of throwing it so
   * that `readMany` can tell "the aggregator answered with nonsense" from "we never
   * reached the aggregator" — a distinction that is lost the moment both become a 503,
   * and one an operator needs: the first is a broken feed, the second a broken RPC.
   */
  private async attempt(
    feed: Hex,
  ): Promise<{ reading: FeedReading } | { failure: FeedFailure; problem: Problem }> {
    try {
      const [round, decimals] = await Promise.all([
        this.client.readContract({
          address: feed,
          abi: aggregatorV3Abi,
          functionName: "latestRoundData",
        }),
        this.decimalsOf(feed),
      ]);
      return {
        reading: assessRound({
          round: toFeedRound(round),
          decimals,
          nowSeconds: this.nowSeconds(),
          maxAgeSeconds: this.maxAgeSeconds,
        }),
      };
    } catch (error) {
      // Every Problem raised under this try came from our own round validation, so it is
      // the aggregator that is wrong. Anything else is the transport or a decode failure,
      // and is flattened without its payload: provider errors routinely echo the request
      // URL, which carries the API key.
      if (error instanceof Problem) return { failure: "invalid", problem: error };
      return {
        failure: "unreachable",
        problem: Problem.unavailable("A verified reference price is unavailable."),
      };
    }
  }

  /**
   * Read a feed and measure its age. Does NOT refuse a stale answer — it reports
   * `stale: true` so observation endpoints can publish the fact. Use `readFresh` on any
   * path that is about to move money.
   */
  async read(feed: Hex): Promise<FeedReading> {
    const outcome = await this.attempt(feed);
    if ("reading" in outcome) return outcome.reading;
    throw outcome.problem;
  }

  /** Read and refuse to return a stale answer. */
  async readFresh(feed: Hex): Promise<FeedReading> {
    return requireFresh(await this.read(feed));
  }

  /**
   * Read several feeds with per-feed isolation: one dead aggregator must not blank the
   * whole market response. Runs concurrently; the transport's own pacing bounds the burst.
   */
  async readMany(feeds: readonly Hex[]): Promise<FeedBatch> {
    const unique = [...new Set(feeds.map((feed) => feed.toLowerCase()))] as Hex[];
    // allSettled even though `attempt` swallows its own failures: an unexpected throw must
    // still cost one feed rather than the whole market response.
    const settled = await Promise.allSettled(unique.map((feed) => this.attempt(feed)));
    const readings = new Map<string, FeedReading>();
    const unavailable = new Map<string, FeedFailure>();
    settled.forEach((outcome, index) => {
      const key = unique[index];
      if (key === undefined) return;
      if (outcome.status !== "fulfilled") unavailable.set(key, "unreachable");
      else if ("reading" in outcome.value) readings.set(key, outcome.value.reading);
      else unavailable.set(key, outcome.value.failure);
    });
    return { readings, unavailable };
  }

  /**
   * The `oracle:SYMBOL` observation shape the API and worker already consume. Staleness is
   * carried in the payload rather than thrown, matching the documented contract that an
   * unusable observation is `{ value: null, updated_at: 0, stale: true }` while an old but
   * structurally valid one still reports its real timestamp.
   */
  async reference(asset: Asset): Promise<MarketFeed> {
    const reading = await this.read(asset.feed);
    return {
      uri: `oracle:${asset.symbol}`,
      value: reading.value,
      updated_at: reading.updatedAt,
      stale: reading.stale,
    };
  }

  /**
   * The reference price a route must be checked against. Fresh-or-throw by construction:
   * there is no way to obtain this string and forget the staleness check.
   */
  async referencePrice(asset: Asset): Promise<string> {
    return (await this.readFresh(asset.feed)).value;
  }
}
