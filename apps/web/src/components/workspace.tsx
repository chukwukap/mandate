"use client";
import { useDesk } from "../providers/desk-provider";
import { sectionTitles } from "../lib/navigation";
import { DemoBoundary } from "./demo-boundary";
import { OverviewView } from "../features/portfolio/overview-view";
import { PortfolioView } from "../features/portfolio/portfolio-view";
import { MarketExplorer } from "../features/market/market-explorer";
import { TerminalView } from "../features/trading/terminal-view";
import { AutomationsView } from "../features/strategies/automations-view";
import { SignalsView } from "../features/signals/signals-view";
import { DiscoverView } from "../features/discovery/discover-view";
import { ThemeControl } from "../features/settings/theme-control";
import { WorkspaceUpdates } from "../features/signals/workspace-updates";


import {
  Activity,
  Compass,
  ChartNoAxesCombined,
  Radar,
  Layers3,
  PieChart,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  LayoutGrid,
  Menu,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { ActivityView } from "../features/executions/activity-view";
import { companies, stocks } from "../features/market/catalog";
import { MarketsView } from "../features/market/markets-view";
import { StockLogo } from "../features/market/stock-logo";
import { SettingsView } from "../features/settings/settings-view";
import { StrategiesView } from "../features/strategies/strategies-view";
import { StrategyDetails } from "../features/strategies/strategy-details";
import { StrategyEditor } from "../features/strategies/strategy-editor";
import { StrategyRow } from "../features/strategies/strategy-row";
import type { Strategy } from "../features/strategies/types";
import { currency, shortAddress } from "../lib/format";
import { useWorkspace } from "../providers/use-workspace";
import { Dialog } from "./dialog";

const navigation = [
  { href: "/", section: "overview", label: "Overview", icon: LayoutGrid },
  { href: "/markets", section: "markets", label: "Markets", icon: ChartNoAxesCombined },
  { href: "/portfolio", section: "portfolio", label: "Portfolio", icon: PieChart },
  { href: "/trade", section: "trade", label: "Trade", icon: Activity },
  { href: "/automations", section: "automations", label: "Automations", icon: Layers3 },
  { href: "/signals", section: "signals", label: "Signals", icon: Radar },
  { href: "/discover", section: "discover", label: "Discover", icon: Compass },
  { href: "/activity", section: "activity", label: "Activity", icon: Activity },
];

function Mark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M5 24V12a5 5 0 0 1 10 0v12M15 24V12a5 5 0 0 1 10 0v12"
        stroke="currentColor"
        strokeWidth="3.3"
        strokeLinecap="round"
      />
      <path d="M5 24h5m5 0h5m5 0h3" stroke="currentColor" strokeWidth="3.3" strokeLinecap="round" />
    </svg>
  );
}

export function Workspace() {
  const model = useWorkspace();
  const desk = useDesk();
  const showLegacyHeading = ["strategies", "activity", "settings"].includes(model.section) || (!model.preview && model.section === "markets");
  const {
    path,
    router,
    preview,
    session,
    section,
    strategies,
    setStrategies,
    error,
    setError,
    selected,
    setSelected,
    query,
    setQuery,
    compact,
    mobile,
    setMobile,
    editor,
    setEditor,
    connect,
    setConnect,
    help,
    setHelp,
    search,
    setSearch,
    detail,
    toast,
    setToast,
    href,
    call,
    fetchOwned,
    price,
    openEditor,
    login,
    openDetail,
  } = model;
  const strategyRow = (strategy: Strategy, full = false) => (
    <StrategyRow key={strategy.id} strategy={strategy} full={full} openDetail={openDetail} />
  );
  useEffect(() => {
    if (!mobile) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const focusable = () =>
      Array.from(sidebar?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    focusable()[0]?.focus();
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onTab);
    return () => {
      document.removeEventListener("keydown", onTab);
      previous?.focus();
    };
  }, [mobile]);
  const empty = (title: string, description: string, action = true) => (
    <div className="empty-state">
      <span className="empty-icon">
        <SlidersHorizontal size={23} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="button secondary" type="button" onClick={() => openEditor()}>
          <Plus size={15} />
          Create a strategy
        </button>
      )}
    </div>
  );
  return (
    <div className={`workspace desk-workspace ${compact ? "compact" : ""}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {mobile && (
        <button
          type="button"
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
        <Link href={href("/")} className="brand">
          <span>
            <Mark />
          </span>
          mandate<span className="brand-period">.</span>
        </Link>
        <div className="workspace-switch">
          <span className="workspace-avatar">P</span>
          <span>
            {preview ? "Demo workspace" : "Personal workspace"}<small>{preview ? "Your ideas. Zero risk to funds." : "Base network"}</small>
          </span>
          <span className="network-dot" />
        </div>
        <div className="nav-caption">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={href(item.href)}
              onClick={() => setMobile(false)}
              className={(section === item.section || (section === "strategies" && item.section === "automations")) ? "nav-item active" : "nav-item"}
              aria-current={(section === item.section || (section === "strategies" && item.section === "automations")) ? "page" : undefined}
            >
              <item.icon size={18} />
              {item.label}
              {item.label === "Strategies" && strategies.length > 0 && (
                <span className="nav-count">{strategies.length}</span>
              )}
            </Link>
          ))}
        </nav>
        <button
          type="button"
          className="sidebar-new"
          onClick={() => {
            setMobile(false);
            router.push(href("/automations") + (preview ? "&new=dca" : ""));
          }}
        >
          <Plus size={17} />
          Create automation<span>↗</span>
        </button>
        <div className="sidebar-bottom">
          <button type="button" className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />Help & shortcuts
            <ArrowUpRight size={14} className="trailing" />
          </button>
          <Link
            href={href("/settings")}
            className={`nav-item ${section === "settings" ? "active" : ""}`}
            onClick={() => setMobile(false)}
          >
            <Settings2 size={18} />
            Settings
          </Link>
          <div className="sidebar-divider" />
          <button
            type="button"
            className="account-button"
            onClick={session.authenticated ? () => router.push(href("/settings")) : login}
          >
            <span className="account-avatar">
              <Wallet size={18} />
            </span>
            <span>
              {session.wallet ? shortAddress(session.wallet) : "Your wallet"}
              <small>{session.authenticated ? "Connected" : "Connect to get started"}</small>
            </span>
            <ChevronRight size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              type="button"
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Mandate</span>
            <ChevronRight size={13} />
            <strong>{section.charAt(0).toUpperCase() + section.slice(1)}</strong>
          </div>
          <div className="topbar-actions">
            {preview && (
              <span className="preview-badge">
                <i />
                Demo workspace
              </span>
            )}
            <button
              className="search-trigger"
              type="button"
              onClick={() => setSearch(true)}
              aria-label="Search stocks"
            >
              <Search size={17} />
              <span>Search</span>
              <kbd>⌘ K</kbd>
            </button>
            <ThemeControl />
            {preview && <WorkspaceUpdates />}
            <span className="topbar-divider" />
            <button
              className={`button wallet-button ${session.authenticated ? "connected" : ""}`}
              type="button"
              onClick={session.authenticated ? () => router.push(href("/settings")) : login}
              disabled={!session.ready}
            >
              <Wallet size={16} />
              <span>{session.wallet ? shortAddress(session.wallet) : "Connect wallet"}</span>
            </button>
          </div>
        </header>
        <main id="main">
          {showLegacyHeading && (
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {section === "overview" && <DemoBoundary preview={preview} path="/"><OverviewView /></DemoBoundary>}
          {section === "markets" && preview && <MarketExplorer />}
          {section === "trade" && <DemoBoundary preview={preview} path="/trade"><TerminalView /></DemoBoundary>}
          {section === "automations" && <DemoBoundary preview={preview} path="/automations"><AutomationsView /></DemoBoundary>}
          {section === "signals" && <DemoBoundary preview={preview} path="/signals"><SignalsView /></DemoBoundary>}
          {section === "discover" && <DemoBoundary preview={preview} path="/discover"><DiscoverView /></DemoBoundary>}
          {section === "portfolio" && <DemoBoundary preview={preview} path="/portfolio"><PortfolioView /></DemoBoundary>}
          {section === "markets" ? "ONCHAIN EQUITIES" : "YOUR WORKSPACE"}
              </div>
              <h1>
                {
                  {
                    ...sectionTitles,
                    markets: "Markets",
                    strategies: model.detailPage ? (detail?.name ?? "Strategy") : "Your strategies",
                    activity: "Activity",
                    settings: "Settings",
                  }[section]
                }
              </h1>
              <p>
                {
                  {
                    ...Object.fromEntries(Object.keys(sectionTitles).map(key => [key, ""])),
                    markets: "A familiar market. A different way to trade.",
                    strategies: model.detailPage
                      ? "Your rule, limits, and recorded activity."
                      : "Good decisions start with a plan.",
                    activity: "Every move, in one place.",
                    settings: "Make yourself at home.",
                  }[section]
                }
              </p>
            </div>
            {section !== "settings" && (
              <button className="button primary" type="button" onClick={() => openEditor()}>
                <Plus size={17} />
                New strategy
              </button>
            )}
          </div>
          )}
          {error && !detail && (
            <div role="alert" className="error-banner">
              {error}
              <button type="button" onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {section === "markets" && !preview && (
            <MarketsView model={model} strategyRow={strategyRow} empty={empty} />
          )}
          {section === "strategies" && !model.detailPage && (
            <StrategiesView model={model} strategyRow={strategyRow} empty={empty} />
          )}
          {model.detailPage && <StrategyDetails model={model} />}
          {model.detailPage && !detail && !error && (
            <p className="helper">
              {session.authenticated || preview
                ? "Loading strategy…"
                : "Connect your wallet to view this strategy."}
            </p>
          )}
          {section === "activity" && <ActivityView model={model} empty={empty} />}
          {section === "settings" && <SettingsView model={model} />}
          <footer className="workspace-footer">
            <span>
              <i className="base-dot" />
              On Base. On your terms.
            </span>
            <span>
              {preview ? (
                <button type="button" onClick={() => router.push(path)}>
                  Exit preview
                  <ArrowRight size={12} />
                </button>
              ) : (
                "Your wallet. Your rules."
              )}
            </span>
          </footer>
        </main>
      </div>
      {(toast || desk.notice) && (
        <div className="toast" role="status">
          <span>
            <Check size={15} />
          </span>
          {toast || desk.notice}
        </div>
      )}
      {editor && (
        <StrategyEditor
          symbol={selected}
          initialMode={model.initialMode}
          preview={preview}
          onClose={() => setEditor(false)}
          call={call}
          sign={session.sign}
          onCreate={(strategy) => {
            setEditor(false);
            if (strategy) setStrategies((current) => [strategy, ...current]);
            else void fetchOwned();
            setToast(
              preview ? "Saved to your preview workspace" : "Strategy saved. Ready when you are.",
            );
          }}
        />
      )}
      {connect && (
        <Dialog
          title="Welcome to Mandate."
          eyebrow="YOUR WORKSPACE AWAITS"
          onClose={() => setConnect(false)}
        >
          <div className="connect-content">
            <span className="connect-illustration">
              <Wallet size={34} />
              <span>
                <Check size={15} />
              </span>
            </span>
            <p>
              Wallet connection isn't configured in this environment. You can still explore the
              workspace.
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setConnect(false);
                router.push("/?preview=1");
              }}
            >
              Explore a preview
              <ArrowRight size={16} />
            </button>
          </div>
        </Dialog>
      )}
      {help && (
        <Dialog
          title="A little clarity."
          eyebrow="HOW MANDATE WORKS"
          onClose={() => setHelp(false)}
        >
          <div className="help-content">
            <div>
              <span>01</span>
              <section>
                <h3>Choose your moment.</h3>
                <p>Pick a stock, a target price, and a budget.</p>
              </section>
            </div>
            <div>
              <span>02</span>
              <section>
                <h3>Make it your rule.</h3>
                <p>Review and sign your strategy. Start watching when you're ready.</p>
              </section>
            </div>
            <div>
              <span>03</span>
              <section>
                <h3>Keep control.</h3>
                <p>
                  Signal mode never moves funds. Automatic buys need a separate wallet permission.
                  Pausing a strategy doesn't revoke that permission.
                </p>
              </section>
            </div>
          </div>
        </Dialog>
      )}
      {search && (
        <Dialog
          title="Find your next move."
          onClose={() => {
            setSearch(false);
            setQuery("");
          }}
        >
          <div className="command-search">
            <Search size={19} />
            <input
              autoFocus
              aria-label="Search company or ticker"
              placeholder="Company or ticker…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>ESC</kbd>
          </div>
          <div className="command-results">
            {stocks
              .filter((symbol) =>
                `${symbol} ${companies[symbol]?.name}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((symbol) => (
                <button
                  type="button"
                  key={symbol}
                  onClick={() => {
                    setSelected(symbol);
                    setSearch(false);
                    setQuery("");
                    router.push(href("/trade") + (preview ? "&" : "?") + `symbol=${symbol}`);
                  }}
                >
                  <StockLogo symbol={symbol} />
                  <span>
                    <strong>{companies[symbol]?.name}</strong>
                    <small>{symbol}</small>
                  </span>
                  <span>{currency(price(symbol))}</span>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            {!stocks.some((symbol) =>
              `${symbol} ${companies[symbol]?.name}`.toLowerCase().includes(query.toLowerCase()),
            ) && <p className="table-empty">No matching stocks.</p>}
          </div>
        </Dialog>
      )}
      {!model.detailPage && <StrategyDetails model={model} />}
    </div>
  );
}
