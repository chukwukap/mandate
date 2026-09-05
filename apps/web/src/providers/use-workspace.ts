"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "../features/auth/session-provider";
import { useAuthorizedApi } from "../features/auth/use-authorized-api";
import { useExecutions } from "../features/executions/use-executions";
import { companies, stocks } from "../features/market/catalog";
import { demoPrices } from "../features/market/preview";
import { useMarket } from "../features/market/use-market";
import { useStrategies } from "../features/strategies/use-strategies";
import { workspaceSection } from "../lib/navigation";
import { useWorkspaceState } from "./workspace-state";
export function useWorkspace() {
  const path = usePathname();
  const router = useRouter();
  const detailId = path.match(/^\/strategies\/([^/]+)$/)?.[1];
  const detailPage = Boolean(detailId);
  const params = useSearchParams();
  const preview = params.get("preview") === "1";
  const session = useSession();
  const section = workspaceSection(path);
  const { market, marketError } = useMarket(preview);
  const prefs = useWorkspaceState();
  const initialSymbol = params.get("symbol");
  const [selected, setSelected] = useState(
    initialSymbol && stocks.includes(initialSymbol) ? initialSymbol : "NVDAc",
  );
  const [period, setPeriod] = useState("1D");
  const [filter, setFilter] = useState("All stocks");
  const [strategyFilter, setStrategyFilter] = useState("All");
  const [query, setQuery] = useState("");
  const { favorites, setFavorites, compact, setCompact } = prefs;
  const [mobile, setMobile] = useState(false);
  const [editor, setEditor] = useState(false);
  const createRequested = params.get("create") === "1";
  const initialMode: "manual" | "auto" = params.get("mode") === "auto" ? "auto" : "manual";
  useEffect(() => {
    if (createRequested && (preview || (session.authenticated && session.wallet))) setEditor(true);
  }, [createRequested, preview, session.authenticated, session.wallet]);
  const [connect, setConnect] = useState(false);
  const [help, setHelp] = useState(false);
  const [search, setSearch] = useState(false);
  const [toast, setToast] = useState("");
  const [sort, setSort] = useState(false);

  const auth = useAuthorizedApi(session, preview);
  const { call } = auth;
  const {
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
  } = useStrategies(preview, session, prefs, auth, setToast, detailId);
  const { executions, setExecutions } = useExecutions(
    section,
    preview,
    session.authenticated,
    strategies,
    call,
    setError,
  );
  const href = (target: string) => `${target}${preview ? "?preview=1" : ""}`;
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobile(false);
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearch((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The live reference wherever it is available, in preview as well — the demo simulates
  // positions, not the market. The fixture is the fallback for the first paint and for when the
  // endpoint cannot be reached, and only in preview: an empty price in the signed-in workspace
  // must stay empty rather than quietly showing a number from a file.
  const price = (symbol: string) => {
    const live = market?.feeds.find(
      (feed) => feed.uri === `oracle:${symbol}` && !feed.stale,
    )?.value;
    return live ?? (preview ? demoPrices[symbol] : undefined);
  };
  const company = companies[selected];
  const visibleStocks = stocks
    .filter(
      (symbol) =>
        (filter !== "Watchlist" || favorites.includes(symbol)) &&
        `${symbol} ${companies[symbol]?.name}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => (sort ? Number(price(b) ?? 0) - Number(price(a) ?? 0) : 0));
  const watching = strategies.filter((strategy) => strategy.status === "armed");
  const openEditor = (symbol = selected) => {
    setSelected(symbol);
    setError("");
    if (!preview && (!session.authenticated || !session.wallet)) {
      if (session.configured) session.login();
      else setConnect(true);
      return;
    }
    setEditor(true);
  };
  const login = () => (session.configured ? session.login() : setConnect(true));
  const toggleStar = (symbol: string) => {
    setFavorites((current) =>
      current.includes(symbol) ? current.filter((s) => s !== symbol) : [...current, symbol],
    );
    setToast(favorites.includes(symbol) ? "Removed from watchlist" : "Added to watchlist");
  };
  return {
    path,
    detailPage,
    router,
    preview,
    session,
    section,
    market,
    marketError,
    strategies,
    setStrategies,
    executions,
    setExecutions,
    loading,
    setLoading,
    error,
    setError,
    selected,
    setSelected,
    period,
    setPeriod,
    filter,
    setFilter,
    strategyFilter,
    setStrategyFilter,
    query,
    setQuery,
    favorites,
    compact,
    setCompact,
    mobile,
    setMobile,
    editor,
    initialMode,
    setEditor,
    connect,
    setConnect,
    help,
    setHelp,
    search,
    setSearch,
    detail,
    setDetail,
    busy,
    toast,
    setToast,
    sort,
    setSort,
    nextPage,
    setNextPage,
    href,
    call,
    fetchOwned,
    price,
    company,
    visibleStocks,
    watching,
    openEditor,
    login,
    toggleStar,
    changeStatus,
    openDetail,
  };
}
export type WorkspaceModel = ReturnType<typeof useWorkspace>;
