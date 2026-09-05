"use client";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { ApiCall, Page } from "../../lib/api";
import type { Strategy } from "../strategies/types";
import type { Execution } from "./types";
export function useExecutions(
  section: string,
  preview: boolean,
  authenticated: boolean,
  strategies: Strategy[],
  call: ApiCall,
  setError: Dispatch<SetStateAction<string>>,
) {
  const [executions, setExecutions] = useState<Execution[]>([]);
  useEffect(() => {
    setExecutions([]);
    if (section !== "activity" || preview || !authenticated || !strategies.length) return;
    let active = true;
    void Promise.all(
      strategies.map(async (strategy) => {
        const page = await call<Page<Execution>>(
          `/v1/instances/${strategy.id}/executions?limit=20`,
        );
        return page.items.map((item) => ({ ...item, name: strategy.name }));
      }),
    )
      .then((rows) => {
        if (active)
          setExecutions(rows.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      })
      .catch(() => {
        if (active) setError("Couldn't load recent activity. Try refreshing.");
      });
    return () => {
      active = false;
    };
  }, [section, preview, authenticated, strategies, call, setError]);
  return { executions, setExecutions };
}
