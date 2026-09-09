"use client";
import { useCallback, useEffect, useState } from "react";
import type { Page } from "../../lib/api";
import { ApiError } from "../../lib/api";
import type { useSession } from "../auth/session-provider";
import type { useAuthorizedApi } from "../auth/use-authorized-api";
import type { Strategy } from "./types";
export function useStrategies(
  session: ReturnType<typeof useSession>,
  auth: ReturnType<typeof useAuthorizedApi>,
  setToast: (value: string) => void,
  detailId?: string,
) {
  const { call, identity, currentIdentity } = auth;
  // One source. There used to be two — a live list and a mutable fixture list chosen by a
  // preview flag — which is how a "saved" strategy could exist on screen and nowhere else.
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Strategy | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextPage, setNextPage] = useState<Page<Strategy>["next_page"]>(null);
  const fetchOwned = useCallback(async () => {
    if (!session.authenticated) {
      setStrategies([]);
      setNextPage(null);
      return;
    }
    const owner = identity;
    setLoading(true);
    setError("");
    try {
      const page = await call<Page<Strategy>>("/v1/instances?limit=50");
      if (currentIdentity.current === owner) {
        setStrategies(page.items);
        setNextPage(page.next_page);
      }
    } catch (e) {
      if (currentIdentity.current === owner)
        setError(e instanceof Error ? e.message : "Couldn't load strategies.");
    } finally {
      if (currentIdentity.current === owner) setLoading(false);
    }
  }, [session.authenticated, identity, call, currentIdentity]);
  // Fetching is keyed to identity; signing out removes the previous owner's data.
  useEffect(() => {
    setStrategies([]);
    setDetail(null);
    void fetchOwned();
  }, [fetchOwned]);
  useEffect(() => {
    if (!detailId) return;
    let active = true;
    if (session.authenticated) {
      void call<Strategy>(`/v1/instances/${encodeURIComponent(detailId)}`)
        .then((value) => {
          if (active) setDetail(value);
        })
        .catch((error) => {
          if (!active) return;
          // A link to a strategy that is not this user's, or not anyone's, is answered with the
          // API's schema or not-found wording. Neither says the one thing the person needs.
          const missing =
            error instanceof ApiError && (error.status === 404 || error.status === 400);
          setError(
            missing
              ? "That strategy isn't here. Check the link, or go back to your strategies."
              : error instanceof Error
                ? error.message
                : "Couldn't load strategy.",
          );
        });
    }
    return () => {
      active = false;
    };
  }, [detailId, session.authenticated, call]);
  const changeStatus = async (strategy: Strategy, action: "arm" | "pause" | "kill") => {
    setBusy(true);
    setError("");
    try {
      const updated = await call<Strategy>(`/v1/instances/${strategy.id}/${action}`, {});
      setStrategies((rows) =>
        rows.map((row) => (row.id === strategy.id ? { ...row, ...updated } : row)),
      );
      if (detail?.id === strategy.id)
        setDetail((current) => (current ? { ...current, ...updated } : current));
      setToast(
        `Strategy ${action === "arm" ? "watching" : action === "pause" ? "paused" : "stopped"}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update the strategy.");
    } finally {
      setBusy(false);
    }
  };
  const openDetail = async (strategy: Strategy) => {
    setDetail(strategy);
    setError("");
    try {
      // The row already on screen is a summary; the detail route carries the full review.
      const value = await call<Strategy>(`/v1/instances/${strategy.id}`);
      setDetail((current) => (current?.id === strategy.id ? value : current));
      // The row behind the dialog is refreshed from the same read. Otherwise a strategy that
      // has just signalled shows "1 order" in the dialog and "0 orders" in the list until the
      // next poll — two answers to one question, on one screen.
      setStrategies((rows) =>
        rows.map((row) => (row.id === value.id ? { ...row, ...value } : row)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the review.");
    }
  };
  return {
    strategies,
    setStrategies,
    loading,
    setLoading,
    error,
    setError,
    detail,
    setDetail,
    busy,
    nextPage,
    setNextPage,
    fetchOwned,
    changeStatus,
    openDetail,
  };
}
