"use client";
import { useEffect, useState } from "react";
import { request } from "../../lib/api";
import { publishLivePrices } from "../trading/market-data";
import type { Market } from "./types";

/**
 * "oracle:AAPLc" -> ["AAPLc", 320.08]. Unparseable readings are dropped; STALE ONES ARE NOT.
 *
 * Staleness gates trading, not display. These are total-return equity feeds with no heartbeat
 * while the underlying market is shut, so every symbol crosses the 26h bound over a weekend —
 * measured here on a Saturday, GOOGLc was 26.97h old and therefore "stale" while AAPLc, updated
 * an hour later on Friday, was not. Dropping it left the demo showing a fabricated 201.36
 * against a real last close of 338.71.
 *
 * A held last close is the true most-recent price of the asset. Substituting a fixture for it
 * replaces real information with invented information, which is strictly worse than showing a
 * real number that is a day old. Whether an asset can be TRADED against that reference is a
 * separate decision, made from `feed.stale` where the trading paths already read it.
 */
function referencePrices(market: Market): [string, number][] {
  return market.feeds.flatMap((feed) => {
    if (!feed.value || !feed.uri.startsWith("oracle:")) return [];
    const symbol = feed.uri.slice("oracle:".length);
    const value = Number(feed.value);
    return Number.isFinite(value) && value > 0 ? [[symbol, value] as [string, number]] : [];
  });
}
export function useMarket(preview: boolean) {
  const [market, setMarket] = useState<Market | null>(null);
  const [marketError, setMarketError] = useState(false);
  useEffect(() => {
    // Fetched in preview as well. /v1/market is public, so the demo workspace can show the real
    // market it is demonstrating; only positions and cash are simulated. A failure here is not
    // an error in preview — the fixtures still render a coherent demo — so the error banner is
    // reserved for the signed-in workspace, where a missing market IS a fault the user must see.
    const controller = new AbortController();
    const refresh = () =>
      request<Market>("/v1/market", { signal: controller.signal })
        .then((value) => {
          setMarket(value);
          publishLivePrices(referencePrices(value));
          setMarketError(false);
        })
        .catch(() => {
          if (!controller.signal.aborted && !preview) setMarketError(true);
        });
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [preview]);
  return { market, marketError };
}
