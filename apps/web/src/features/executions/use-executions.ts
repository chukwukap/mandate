"use client";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { ApiCall, Page } from "../../lib/api";
import type { Strategy } from "../strategies/types";
import type { Execution } from "./types";

/** Sections whose views render `executions`. */
const SHOWS_EXECUTIONS = new Set(["activity", "overview"]);

export function useExecutions(
  section: string,
  authenticated: boolean,
  strategies: Strategy[],
  call: ApiCall,
  setError: Dispatch<SetStateAction<string>>,
) {
  const [executions, setExecutions] = useState<Execution[]>([]);
  useEffect(() => {
    setExecutions([]);
    // Both sections that render executions. Gated at all because this fans out to one request
    // per strategy, and a page that never displays them should not pay for them — but the
    // overview does display them, and with "activity" alone its panel was permanently empty
    // while truthfully reporting that it had nothing.
    if (!SHOWS_EXECUTIONS.has(section) || !authenticated || !strategies.length) return;
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
  }, [section, authenticated, strategies, call, setError]);
  return { executions, setExecutions };
}
