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
    // Only the sections that render executions pay for them. This used to fan out to one
    // request per strategy on every refresh, which at eighteen strategies was 36 requests a
    // minute from an idle Overview — a third of the API's whole per-minute allowance, spent
    // before the user had touched anything. The owned-executions list already joins the
    // strategy name, so one page covers every strategy at once.
    if (!SHOWS_EXECUTIONS.has(section) || !authenticated || !strategies.length) return;
    let active = true;
    const names = new Map(strategies.map((strategy) => [strategy.id, strategy.name]));
    void call<Page<Execution>>("/v1/executions?limit=100")
      .then((page) => {
        if (active)
          setExecutions(
            page.items
              .map((item) => {
                const name = item.strategy_name ?? names.get(item.instanceId) ?? item.name;
                return name ? { ...item, name } : item;
              })
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          );
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
