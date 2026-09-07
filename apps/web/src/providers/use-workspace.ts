"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "../features/auth/session-provider";
import { useAuthorizedApi } from "../features/auth/use-authorized-api";
import { useExecutions } from "../features/executions/use-executions";
import { companies, stocks } from "../features/market/catalog";
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
  /**
   * The reference price for one symbol, stale or not.
   *
   * `stale` used to disqualify a feed here, and that emptied the entire market page for most of
   * every week. These are Chainlink equity feeds with no off-hours heartbeat: `MAX_REFERENCE_AGE`
   * is 26 hours, so from Friday's close until Monday's open every one of the seven feeds is
   * flagged stale and every price on screen rendered as "—". Observed on a Monday holiday with
   * all seven feeds carrying real values 67 hours old.
   *
   * A held last close is not "no price". It is the last price the reference actually recorded,
   * and the tokens keep trading on Aerodrome the whole time — the same argument that produced
   * MAX_VALIDATION_AGE in packages/evm/src/clients/base.ts. So the number is shown, and
   * `priceStale` tells the caller to label it rather than hide it. Suppressing a real number is
   * not the cautious choice; it is a blank screen that says nothing at all.
   */
  const priceFeed = (symbol: string) =>
    market?.feeds.find((feed) => feed.uri === `oracle:${symbol}`);
  const price = (symbol: string) => priceFeed(symbol)?.value ?? undefined;
  /** True when the displayed price is a held close rather than a live reading. */
  const priceStale = (symbol: string) => priceFeed(symbol)?.stale ?? false;
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
    priceStale,
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
