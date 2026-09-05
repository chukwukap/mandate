"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiCall, Page } from "../../lib/api";
import type { Evaluation, Execution } from "./types";
export function useHistory(
  instance: string,
  kind: "evaluations" | "executions",
  preview: boolean,
  call: ApiCall,
) {
  const [page, setPage] = useState<Page<Evaluation | Execution>>({ items: [], next_page: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(
    async (cursor?: Page<unknown>["next_page"]) => {
      const version = generation.current;
      setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ limit: "20" });
        if (cursor) {
          query.set("before", cursor.before);
          query.set("before_id", cursor.before_id);
        }
        const result = await call<Page<Evaluation | Execution>>(
          `/v1/instances/${instance}/${kind}?${query}`,
        );
        if (version === generation.current)
          setPage((current) => ({
            ...result,
            items: cursor ? [...current.items, ...result.items] : result.items,
          }));
      } catch (e) {
        if (version === generation.current)
          setError(e instanceof Error ? e.message : "Couldn't load history.");
      } finally {
        if (version === generation.current) setLoading(false);
      }
    },
    [instance, kind, call],
  );
  useEffect(() => {
    generation.current += 1;
    setPage({ items: [], next_page: null });
    setError("");
    setLoading(false);
    if (!preview) void load();
    return () => {
      generation.current += 1;
    };
  }, [preview, load]);
  return { page, loading, error, load };
}
