"use client";
import { useEffect, useState } from "react";
import { request } from "../../lib/api";
import type { Market } from "./types";
export function useMarket(preview: boolean) {
  const [market, setMarket] = useState<Market | null>(null);
  const [marketError, setMarketError] = useState(false);
  useEffect(() => {
    if (preview) {
      setMarketError(false);
      return;
    }
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
  }, [preview]);
  return { market, marketError };
}
