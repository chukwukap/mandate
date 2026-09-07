"use client";
import { useEffect, useState } from "react";
import { request } from "../../lib/api";
import type { Market } from "./types";

/**
 * The public catalogue and its reference feeds, refreshed every 30 seconds.
 *
 * Stale feeds are kept, not dropped. These are total-return equity feeds with no heartbeat while
 * the underlying market is shut, so every symbol crosses the 26h bound over a weekend — measured
 * on a Saturday, GOOGLc was 26.97h old and therefore "stale" while AAPLc, updated an hour later
 * on Friday, was not. A held last close is the asset's true most-recent price; whether it can be
 * TRADED against is a separate decision the trading paths make from `feed.stale` directly.
 */
export function useMarket() {
  const [market, setMarket] = useState<Market | null>(null);
  const [marketError, setMarketError] = useState(false);
  useEffect(() => {
    // Public, so this runs before any wallet is connected: the catalogue and its prices are the
    // first thing a visitor should see, and asking for a signature to show a price list is
    // backwards. A failure here is a real fault and surfaces as one — there is no fixture behind
    // it any more to paper over the gap.
    const controller = new AbortController();
    const refresh = () =>
      request<Market>("/v1/market", { signal: controller.signal })
        .then((value) => {
          setMarket(value);
          setMarketError(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setMarketError(true);
        });
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return { market, marketError };
}
