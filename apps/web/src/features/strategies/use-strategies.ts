"use client";
import { useCallback, useEffect, useState } from "react";
import type { Page } from "../../lib/api";
import type { useWorkspaceState } from "../../providers/workspace-state";
import type { useSession } from "../auth/session-provider";
import type { useAuthorizedApi } from "../auth/use-authorized-api";
import type { Strategy } from "./types";
export function useStrategies(
  preview: boolean,
  session: ReturnType<typeof useSession>,
  prefs: ReturnType<typeof useWorkspaceState>,
  auth: ReturnType<typeof useAuthorizedApi>,
  setToast: (value: string) => void,
  detailId?: string,
) {
  const { call, identity, currentIdentity } = auth;
  const [liveStrategies, setLiveStrategies] = useState<Strategy[]>([]);
  const strategies = preview ? prefs.previewStrategies : liveStrategies;
  const setStrategies = preview ? prefs.setPreviewStrategies : setLiveStrategies;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Strategy | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextPage, setNextPage] = useState<Page<Strategy>["next_page"]>(null);
  const fetchOwned = useCallback(async () => {
    if (preview) {
      setNextPage(null);
      return;
    }
    if (!session.authenticated) {
      setLiveStrategies([]);
      setNextPage(null);
      return;
    }
    const owner = identity;
    setLoading(true);
    setError("");
    try {
      const page = await call<Page<Strategy>>("/v1/instances?limit=50");
      if (currentIdentity.current === owner) {
        setLiveStrategies(page.items);
        setNextPage(page.next_page);
      }
    } catch (e) {
      if (currentIdentity.current === owner)
        setError(e instanceof Error ? e.message : "Couldn't load strategies.");
    } finally {
      if (currentIdentity.current === owner) setLoading(false);
    }
  }, [preview, session.authenticated, identity, call, currentIdentity]);
  // Fetching is keyed to identity; signing out removes the previous owner's data.
  useEffect(() => {
    setLiveStrategies([]);
    setDetail(null);
    void fetchOwned();
  }, [fetchOwned]);
  useEffect(() => {
    if (!detailId) return;
    let active = true;
    if (preview) {
      const found = prefs.previewStrategies.find((row) => row.id === detailId);
      setDetail(found ?? null);
      if (!found)
        setError("That preview strategy is unavailable. Preview changes reset on reload.");
    } else if (session.authenticated) {
      void call<Strategy>(`/v1/instances/${encodeURIComponent(detailId)}`)
        .then((value) => {
          if (active) setDetail(value);
        })
        .catch((error) => {
          if (active) setError(error instanceof Error ? error.message : "Couldn't load strategy.");
        });
    }
    return () => {
      active = false;
    };
  }, [detailId, preview, prefs.previewStrategies, session.authenticated, call]);
  const changeStatus = async (strategy: Strategy, action: "arm" | "pause" | "kill") => {
    setBusy(true);
    setError("");
    try {
      const updated = preview
        ? {
            ...strategy,
            status: (action === "arm"
              ? "armed"
              : action === "pause"
                ? "paused"
                : "halted") as Strategy["status"],
          }
        : await call<Strategy>(`/v1/instances/${strategy.id}/${action}`, {});
      setStrategies((rows) =>
        rows.map((row) => (row.id === strategy.id ? { ...row, ...updated } : row)),
      );
      if (detail?.id === strategy.id)
        setDetail((current) => (current ? { ...current, ...updated } : current));
      setToast(
        `${preview ? "Preview: " : ""}strategy ${action === "arm" ? "watching" : action === "pause" ? "paused" : "stopped"}`,
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
    if (!preview)
      try {
        const value = await call<Strategy>(`/v1/instances/${strategy.id}`);
        setDetail((current) => (current?.id === strategy.id ? value : current));
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
