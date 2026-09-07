"use client";
import { useCallback, useEffect, useState } from "react";
import type { useSession } from "../auth/session-provider";

type Session = ReturnType<typeof useSession>;

export type Holding = {
  symbol: string;
  token: string;
  decimals: number;
  quantity: string;
  price: string | null;
  value: string | null;
  stale: boolean;
};

export type Portfolio = {
  chain_id: number;
  as_of: string;
  wallet: string;
  cash: string;
  holdings: Holding[];
  equity: string | null;
  unpriced: string[];
  notice: string;
};

/**
 * What the connected wallet holds, from `GET /v1/portfolio`.
 *
 * Authenticated, unlike `useMarket`: the endpoint answers for the caller's own linked wallets
 * and refuses any other address, so there is nothing to fetch before a wallet is connected. That
 * is a state, not a failure — `portfolio` stays null and the view shows the connect prompt.
 *
 * Refreshed on an interval rather than on focus alone because balances change underneath the
 * user: a strategy the worker executes moves them with no interaction in this tab at all.
 */
export function usePortfolio(
  session: Session,
  call: <T>(path: string, body?: unknown) => Promise<T>,
) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const ready = session.authenticated && Boolean(session.wallet);

  const refresh = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      setPortfolio(await call<Portfolio>("/v1/portfolio"));
      setError(null);
    } catch {
      // The previous reading stays on screen. A balance a minute old is a better answer than an
      // empty panel, and emptying it on one failed poll reads as "you sold everything".
      setError("Balances are unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [ready, call]);

  useEffect(() => {
    if (!ready) {
      setPortfolio(null);
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [ready, refresh]);

  return { portfolio, error, loading, refresh, ready };
}
