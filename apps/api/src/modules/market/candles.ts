import type { Asset } from "@mandate/contracts";
import { Problem } from "@mandate/contracts";

/**
 * Real OHLCV for a B20 pool, from GeckoTerminal.
 *
 * The chart used to draw candles generated from a sine wave. They looked like a market and were
 * not one, which is fine for a layout preview and dishonest on a page that also quotes a live
 * price — a reader has no way to tell which parts of the screen are real.
 *
 * GeckoTerminal indexes Aerodrome and serves OHLCV for a pool without an API key, so the chart
 * can show what actually traded. Verified against the AAPLc/USDC pool: hourly candles with
 * volume, matching the price the venue quotes.
 *
 * # Why the server fetches this and not the browser
 *
 * Three reasons, in order of how much they would hurt. A browser fetch is subject to whatever
 * CORS policy GeckoTerminal chooses tomorrow. Rate limits are per-IP, so every viewer would spend
 * from the same bucket as every other viewer behind the same NAT, and a shared cache here turns
 * a hundred readers into one upstream call. And the frontend already speaks to exactly one origin,
 * which is a property worth keeping.
 */

/** What the chart draws. Times are Unix seconds, as lightweight-charts expects. */
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * The intervals the chart offers, mapped to what GeckoTerminal actually serves.
 *
 * Probed against a live pool rather than read from documentation: `day&aggregate=7` returns an
 * empty list, so a week view is drawn from daily candles over a longer window instead of a
 * seven-day aggregate that does not exist.
 */
export const INTERVALS = {
  "15m": { timeframe: "minute", aggregate: 15, limit: 96 },
  "1H": { timeframe: "hour", aggregate: 1, limit: 168 },
  "4H": { timeframe: "hour", aggregate: 4, limit: 180 },
  "1D": { timeframe: "day", aggregate: 1, limit: 180 },
  "1W": { timeframe: "day", aggregate: 1, limit: 365 },
} as const;

export type Interval = keyof typeof INTERVALS;
export const isInterval = (value: string): value is Interval => value in INTERVALS;

const GECKO = "https://api.geckoterminal.com/api/v2/networks/base";
const DEX = "https://api.dexscreener.com/latest/dex/tokens";

/** Pools are stable; a resolved address is worth keeping for the life of the process. */
const pools = new Map<string, string>();
/** Candles are not. Sixty seconds is shorter than the shortest interval offered. */
const CANDLE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; candles: Candle[] }>();

type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The deepest Aerodrome pool for a token.
 *
 * Depth decides, not recency: the same pair exists at several tick spacings and the thin ones
 * quote nonsense. The measured case is AAPLc, whose spacing-200 pool prices a share at $37,861
 * against a $320 reference — a chart drawn from that pool would be a chart of an error.
 */
async function resolvePool(asset: Asset, fetcher: Fetcher): Promise<string> {
  const known = pools.get(asset.symbol);
  if (known) return known;

  const body = (await paced(() =>
    withTimeout(
      (signal) => fetcher(`${DEX}/${asset.token}`, { signal }).then((r) => r.json()),
      8_000,
    ),
  )) as {
    pairs?: {
      chainId?: string;
      dexId?: string;
      pairAddress?: string;
      liquidity?: { usd?: number };
    }[];
  };

  const best = (body.pairs ?? [])
    .filter((p) => p.chainId === "base" && p.pairAddress)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  if (!best?.pairAddress) {
    throw Problem.unavailable(
      `No indexed Base pool for ${asset.symbol}, so there is no price history to draw.`,
    );
  }
  pools.set(asset.symbol, best.pairAddress);
  return best.pairAddress;
}

/** GeckoTerminal returns newest-first tuples; lightweight-charts needs oldest-first objects. */
function toCandles(raw: unknown): Candle[] {
  const list = (raw as { data?: { attributes?: { ohlcv_list?: unknown[] } } })?.data?.attributes
    ?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((entry): Candle[] => {
      if (!Array.isArray(entry) || entry.length < 6) return [];
      const [time, open, high, low, close, volume] = entry.map(Number) as (number | undefined)[];
      // A candle with a non-finite or non-positive price is not a datum to plot around; drawing
      // it would rescale the whole chart around a point that never traded.
      const prices = [time, open, high, low, close];
      if (!prices.every((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)) {
        return [];
      }
      return [
        {
          time: time as number,
          open: open as number,
          high: high as number,
          low: low as number,
          close: close as number,
          volume: typeof volume === "number" && Number.isFinite(volume) ? volume : 0,
        },
      ];
    })
    .sort((a, b) => a.time - b.time);
}

/**
 * Upstream calls are spaced, not merely capped, so one page load cannot burst GeckoTerminal.
 *
 * The market page renders a sparkline per row, so a cold load asks for seven distinct
 * (symbol, interval) pairs at once — none cached, all misses. Concurrency alone was not enough:
 * with a three-at-a-time gate, two of the seven still came back 429 and reached the browser as
 * 503s with two blank sparklines. The free tier limits by RATE, so the fix is a minimum gap
 * between calls rather than a cap on how many overlap.
 *
 * 220ms is ~4.5 calls a second. Seven cold sparklines therefore take about 1.5s to fill, against
 * a per-call latency of several hundred milliseconds anyway, and the 60s cache means this is
 * paid once per interval rather than per viewer.
 */
const SPACING_MS = 220;
let nextSlotAt = 0;

async function paced<T>(work: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + SPACING_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  return work();
}

/**
 * One retry on a rate limit, because the first 429 is the one that is recoverable.
 *
 * A rate limit is not the same failure as a dead upstream: it says "later", and later is a
 * second away. Retrying once converts the common case — a burst that briefly outran the
 * spacing — into a slightly slower success instead of a blank chart. Anything past one retry is
 * queueing behind a limit that is genuinely exhausted, which the cache and the stale fallback
 * already handle better.
 */
const RATE_LIMITED = 429;
async function fetchCandles(
  url: string,
  fetcher: Fetcher,
): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> {
  const attempt = () =>
    paced(() =>
      withTimeout(
        (signal) =>
          fetcher(url, { signal }) as Promise<{
            ok: boolean;
            status?: number;
            json(): Promise<unknown>;
          }>,
        10_000,
      ),
    );
  const first = await attempt();
  if (first.ok || first.status !== RATE_LIMITED) return first;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  return attempt();
}

/**
 * One in-flight request per (symbol, interval).
 *
 * Seven sparklines for the same symbol at the same interval — which the overview and the market
 * page between them can produce — would otherwise be seven identical upstream calls racing to
 * fill one cache entry.
 */
const inflight = new Map<string, Promise<Candle[]>>();

export async function candlesFor(
  asset: Asset,
  interval: Interval,
  fetcher: Fetcher = globalThis.fetch,
): Promise<Candle[]> {
  const key = `${asset.symbol}:${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.candles;

  const running = inflight.get(key);
  if (running) return running;
  const request = load(asset, interval, key, fetcher).finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

async function load(
  asset: Asset,
  interval: Interval,
  key: string,
  fetcher: Fetcher,
): Promise<Candle[]> {
  const hit = cache.get(key);
  const pool = await resolvePool(asset, fetcher);
  const { timeframe, aggregate, limit } = INTERVALS[interval];
  const url = `${GECKO}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`;

  const response = await fetchCandles(url, fetcher);
  if (!response.ok) {
    // Serve a stale window rather than an empty chart: a minute-old candle is a better answer
    // than a blank panel, and the alternative is the reader assuming the market stopped.
    if (hit) return hit.candles;
    throw Problem.unavailable("Price history is temporarily unavailable for this market.");
  }

  const candles = toCandles(await response.json());
  if (candles.length === 0 && hit) return hit.candles;
  cache.set(key, { at: Date.now(), candles });
  return candles;
}

/** Exposed so tests can start from a known state; nothing in the request path calls it. */
export function resetCandleCache(): void {
  cache.clear();
  pools.clear();
}
