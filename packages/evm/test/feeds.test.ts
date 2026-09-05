import { expect, test } from "bun:test";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  parseAbi,
} from "viem";
import { base } from "viem/chains";
import { ASSETS } from "../src/addresses/index.js";
import {
  assessRound,
  ChainlinkFeeds,
  type FeedRound,
  MAX_FEED_AGE_SECONDS,
  requireFresh,
} from "../src/feeds/index.js";

const asset = (() => {
  const first = ASSETS[0];
  if (!first) throw new Error("Missing fixture asset");
  return first;
})();

// Declared independently of src/abis so a drift there shows up as a decode failure here.
const aggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

const HOUR = 3600;
const NOW_SECONDS = 1_760_000_000;
const NOW_MS = NOW_SECONDS * 1000;
/** AAPLc/USD at 8 decimals: $320.08. */
const ANSWER = 32_008_000_000n;

type FeedState = {
  answer?: bigint;
  ageSeconds?: number;
  updatedAt?: bigint;
  roundId?: bigint;
  answeredInRound?: bigint;
  decimals?: number;
  fail?: boolean;
};

function harness(states: Record<string, FeedState> = {}) {
  let decimalsReads = 0;
  let roundReads = 0;
  const client = createPublicClient({
    chain: base,
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x2105";
          if (method !== "eth_call") throw new Error("Unexpected RPC method");
          const [{ to, data }] = params as [{ to: Hex; data: Hex }];
          const state = states[to.toLowerCase()] ?? {};
          if (state.fail) throw new Error("upstream unavailable");
          const { functionName } = decodeFunctionData({ abi: aggregatorAbi, data });
          if (functionName === "decimals") {
            decimalsReads++;
            return encodeFunctionResult({
              abi: aggregatorAbi,
              functionName,
              result: state.decimals ?? 8,
            });
          }
          roundReads++;
          const updatedAt = state.updatedAt ?? BigInt(NOW_SECONDS - (state.ageSeconds ?? 5 * HOUR));
          const roundId = state.roundId ?? 110n;
          return encodeFunctionResult({
            abi: aggregatorAbi,
            functionName,
            result: [
              roundId,
              state.answer ?? ANSWER,
              updatedAt,
              updatedAt,
              state.answeredInRound ?? roundId,
            ],
          });
        },
      },
      { retryCount: 0 },
    ),
  });
  return {
    feeds: new ChainlinkFeeds(client, { now: () => NOW_MS }),
    decimalsReads: () => decimalsReads,
    roundReads: () => roundReads,
  };
}

function round(overrides: Partial<FeedRound> = {}): FeedRound {
  return {
    roundId: 110n,
    answer: ANSWER,
    startedAt: BigInt(NOW_SECONDS - 5 * HOUR),
    updatedAt: BigInt(NOW_SECONDS - 5 * HOUR),
    answeredInRound: 110n,
    ...overrides,
  };
}

test("the bound is the 24h heartbeat plus slack, not a trading session", () => {
  expect(MAX_FEED_AGE_SECONDS).toBe(26 * HOUR);
  const quiet = round({ updatedAt: BigInt(NOW_SECONDS - 25 * HOUR) });
  // 25h old is a feed that simply has not moved past its deviation threshold. It is fresh.
  expect(assessRound({ round: quiet, decimals: 8, nowSeconds: NOW_SECONDS }).stale).toBe(false);
  // 27h old is past the heartbeat plus slack: the aggregator has actually stopped.
  const dead = round({ updatedAt: BigInt(NOW_SECONDS - 27 * HOUR) });
  expect(assessRound({ round: dead, decimals: 8, nowSeconds: NOW_SECONDS }).stale).toBe(true);
  // The failure this bound exists to avoid: the worker's 300s rule refuses BOTH, and would
  // also refuse a round only ten minutes old, i.e. every automatic order outside a
  // price-moving event.
  for (const stopped of [quiet, dead, round({ updatedAt: BigInt(NOW_SECONDS - 600) })])
    expect(
      assessRound({ round: stopped, decimals: 8, nowSeconds: NOW_SECONDS, maxAgeSeconds: 300 })
        .stale,
    ).toBe(true);
});

test("requireFresh refuses a stale answer and names the ages", () => {
  const stale = assessRound({
    round: round({ updatedAt: BigInt(NOW_SECONDS - 27 * HOUR) }),
    decimals: 8,
    nowSeconds: NOW_SECONDS,
  });
  expect(() => requireFresh(stale)).toThrow();
  try {
    requireFresh(stale);
  } catch (error) {
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toContain("97200s");
    expect((error as Error).message).toContain("93600s");
  }
  const fresh = assessRound({ round: round(), decimals: 8, nowSeconds: NOW_SECONDS });
  expect(requireFresh(fresh)).toBe(fresh);
});

test("structurally impossible rounds are refused rather than scaled", () => {
  const cases: Partial<FeedRound>[] = [
    { answer: 0n },
    { answer: -1n },
    { updatedAt: 0n },
    { roundId: 0n },
    // A far-future timestamp is a rogue aggregator, not clock skew, and must never read
    // as maximally fresh.
    { updatedAt: BigInt(NOW_SECONDS + HOUR) },
    { roundId: 110n, answeredInRound: 109n },
  ];
  for (const overrides of cases)
    expect(() =>
      assessRound({ round: round(overrides), decimals: 8, nowSeconds: NOW_SECONDS }),
    ).toThrow();
  // Within the tolerated skew a future timestamp is "just published", age clamped to 0.
  const skewed = assessRound({
    round: round({ updatedAt: BigInt(NOW_SECONDS + 30) }),
    decimals: 8,
    nowSeconds: NOW_SECONDS,
  });
  expect(skewed.ageSeconds).toBe(0);
  expect(skewed.stale).toBe(false);
  expect(() => assessRound({ round: round(), decimals: 40, nowSeconds: NOW_SECONDS })).toThrow();
});

test("the answer is scaled by the feed's own decimals, never an assumed 18", () => {
  expect(assessRound({ round: round(), decimals: 8, nowSeconds: NOW_SECONDS }).value).toBe(
    "320.08",
  );
  expect(assessRound({ round: round(), decimals: 18, nowSeconds: NOW_SECONDS }).value).toBe(
    "0.000000032008",
  );
});

test("a live read reports value, age and the oracle observation shape", async () => {
  const { feeds } = harness({ [asset.feed.toLowerCase()]: { ageSeconds: 25 * HOUR } });
  const reading = await feeds.read(asset.feed);
  expect(reading.value).toBe("320.08");
  expect(reading.decimals).toBe(8);
  expect(reading.ageSeconds).toBe(25 * HOUR);
  expect(reading.stale).toBe(false);
  expect(await feeds.referencePrice(asset)).toBe("320.08");
  expect(await feeds.reference(asset)).toEqual({
    uri: `oracle:${asset.symbol}`,
    value: "320.08",
    updated_at: NOW_SECONDS - 25 * HOUR,
    stale: false,
  });
});

test("a stale feed is observable but cannot support an action", async () => {
  const { feeds } = harness({ [asset.feed.toLowerCase()]: { ageSeconds: 30 * HOUR } });
  const observation = await feeds.reference(asset);
  expect(observation.stale).toBe(true);
  expect(observation.value).toBe("320.08");
  await expect(feeds.readFresh(asset.feed)).rejects.toMatchObject({ status: 503 });
  await expect(feeds.referencePrice(asset)).rejects.toMatchObject({ status: 503 });
});

test("decimals are read once per feed and never cached from a bad read", async () => {
  const { feeds, decimalsReads, roundReads } = harness();
  await feeds.read(asset.feed);
  await feeds.read(asset.feed);
  await feeds.read(asset.feed);
  expect(roundReads()).toBe(3);
  expect(decimalsReads()).toBe(1);
  const bad = harness({ [asset.feed.toLowerCase()]: { decimals: 40 } });
  await expect(bad.feeds.read(asset.feed)).rejects.toMatchObject({ status: 503 });
  await expect(bad.feeds.read(asset.feed)).rejects.toMatchObject({ status: 503 });
  expect(bad.decimalsReads()).toBe(2);
});

test("one dead aggregator does not blank the rest of the market", async () => {
  const other = ASSETS[1];
  if (!other) throw new Error("Missing second fixture asset");
  const { feeds } = harness({
    [asset.feed.toLowerCase()]: { ageSeconds: HOUR },
    [other.feed.toLowerCase()]: { fail: true },
  });
  const batch = await feeds.readMany([asset.feed, other.feed, asset.feed]);
  expect(batch.readings.get(asset.feed.toLowerCase())?.value).toBe("320.08");
  expect(batch.unavailable.get(other.feed.toLowerCase())).toBe("unreachable");
  // Deduplicated: the repeated address is read once.
  expect(batch.readings.size + batch.unavailable.size).toBe(2);
  // An aggregator that answers with nonsense is distinguishable from one we never reached.
  const invalid = harness({ [asset.feed.toLowerCase()]: { answer: 0n } });
  const second = await invalid.feeds.readMany([asset.feed]);
  expect(second.unavailable.get(asset.feed.toLowerCase())).toBe("invalid");
});

test("upstream failures never leak the provider URL or error text", async () => {
  const { feeds } = harness({ [asset.feed.toLowerCase()]: { fail: true } });
  try {
    await feeds.read(asset.feed);
    throw new Error("expected a failure");
  } catch (error) {
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toBe("A verified reference price is unavailable.");
  }
});
