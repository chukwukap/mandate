"use client";
import { useEffect, useState } from "react";
import { request } from "../../lib/api";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandleInterval = "15m" | "1H" | "4H" | "1D" | "1W";

type CandleResponse = {
  symbol: string;
  interval: CandleInterval;
  source: string;
  candles: Candle[];
};

/**
 * Observed OHLCV for one market, refreshed while the tab is watching it.
 *
 * `/v1/market/candles` is public, so this works before a wallet is connected — the chart is the
 * first thing a visitor looks at and asking for a signature to see one is backwards.
 *
 * The refresh is paused when the document is hidden. A background tab polling every half minute
 * spends the shared upstream rate limit on a chart nobody is looking at, and the first thing that
 * happens on return is a fetch anyway.
 */
export function useCandles(symbol: string, interval: CandleInterval) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = () =>
      request<CandleResponse>(
        `/v1/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`,
        { signal: controller.signal },
      )
        .then((body) => {
          setCandles(body.candles);
          setError(null);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // Keep whatever is already drawn. A chart that empties itself on one failed poll is
          // worse than a chart a minute behind, and the caller cannot tell the difference
          // between "no history" and "the last request failed" unless it is told.
          setError("Price history is unavailable right now.");
        });

    void load();
    const start = () => {
      clearInterval(timer);
      // A quarter of the shortest interval offered: fresh enough that a 15m candle updates
      // several times while it forms, slow enough to stay well inside the upstream limit.
      timer = setInterval(() => void load(), 30_000);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        clearInterval(timer);
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [symbol, interval]);

  return { candles, error };
}
