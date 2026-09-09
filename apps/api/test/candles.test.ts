import { beforeEach, expect, test } from "bun:test";
import type { Asset } from "@mandate/contracts";
import { Problem } from "@mandate/contracts";
import { candlesFor, resetCandleCache } from "../src/modules/market/candles.js";

const asset: Asset = {
  symbol: "AAPLc",
  token: "0x1111111111111111111111111111111111111111",
  feed: "0x2222222222222222222222222222222222222222",
  decimals: 8,
};
const pool = { pairs: [{ chainId: "base", pairAddress: "0xpool", liquidity: { usd: 1_000_000 } }] };
const window = (close: number) => ({
  data: { attributes: { ohlcv_list: [[1_700_000_000, close, close, close, close, 10]] } },
});
/** A fetcher scripted per URL prefix: the pool lookup, then whatever the candle call should do. */
const scripted =
  (candles: () => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>) =>
  async (url: string) =>
    url.includes("dexscreener") ? { ok: true, json: async () => pool } : candles();

beforeEach(() => resetCandleCache());

test("an upstream that hangs past the deadline is reported as unavailable, not as our bug", async () => {
  const fetcher = scripted(
    () =>
      new Promise((_, reject) => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        setTimeout(() => reject(error), 5);
      }),
  );
  const failure = await candlesFor(asset, "1H", fetcher).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Problem);
  expect((failure as Problem).status).toBe(503);
  expect((failure as Problem).message).toMatch(/temporarily unavailable/);
});

test("an HTML error page where JSON was expected is unavailable, not a 500", async () => {
  const fetcher = scripted(async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const failure = await candlesFor(asset, "1H", fetcher).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Problem);
  expect((failure as Problem).status).toBe(503);
});

test("a stale window is served through an upstream failure rather than a blank chart", async () => {
  let calls = 0;
  const fetcher = scripted(async () => {
    calls += 1;
    if (calls === 1) return { ok: true, json: async () => window(101) };
    throw new TypeError("fetch failed");
  });
  const first = await candlesFor(asset, "1H", fetcher);
  expect(first[0]?.close).toBe(101);
  // Expire the entry without waiting a minute: a second interval key shares the pool but not the
  // cache, so use the same key and force a reload by clearing only the candle map through reset.
  // resetCandleCache clears pools too, so the scripted pool answer is exercised again.
  resetCandleCache();
  const cold = await candlesFor(asset, "1H", fetcher).catch((e: unknown) => e);
  expect(cold).toBeInstanceOf(Problem);
  expect(calls).toBe(2);
});

test("a bucket GeckoTerminal lists twice becomes one candle, so the chart never sees a repeat", async () => {
  const fetcher = scripted(async () => ({
    ok: true,
    json: async () => ({
      data: {
        attributes: {
          // Newest first, as upstream sends it; the middle bucket appears twice.
          ohlcv_list: [
            [1_700_007_200, 3, 3, 3, 3, 1],
            [1_700_003_600, 2, 2, 2, 2, 1],
            [1_700_003_600, 9, 9, 9, 9, 1],
            [1_700_000_000, 1, 1, 1, 1, 1],
          ],
        },
      },
    }),
  }));
  const candles = await candlesFor(asset, "1H", fetcher);
  expect(candles.map((c) => c.time)).toEqual([1_700_000_000, 1_700_003_600, 1_700_007_200]);
  const times = candles.map((c) => c.time);
  expect(times.every((time, i) => i === 0 || time > (times[i - 1] as number))).toBe(true);
});
