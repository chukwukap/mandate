"use client";

import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  LayoutGrid,
  Menu,
  PieChart,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { AccountMenu } from "../features/auth/account-menu";
import { DiscoverView } from "../features/discovery/discover-view";
import { ActivityView } from "../features/executions/activity-view";
import { companies, stocks } from "../features/market/catalog";
import { MarketsView } from "../features/market/markets-view";
import { StockLogo } from "../features/market/stock-logo";
import { OverviewView } from "../features/portfolio/overview-view";
import { PortfolioView } from "../features/portfolio/portfolio-view";
import { SettingsView } from "../features/settings/settings-view";
import { ThemeControl } from "../features/settings/theme-control";
import { StrategiesView } from "../features/strategies/strategies-view";
import { StrategyDetails } from "../features/strategies/strategy-details";
import { StrategyEditor } from "../features/strategies/strategy-editor";
import { StrategyRow } from "../features/strategies/strategy-row";
import type { Strategy } from "../features/strategies/types";
import { TerminalView } from "../features/trading/terminal-view";
import { currency, shortAddress } from "../lib/format";
import { sectionTitles, type WorkspaceSection } from "../lib/navigation";
import { useWorkspace } from "../providers/use-workspace";
import { Dialog } from "./dialog";

const sectionSubtitles: Record<WorkspaceSection, string> = {
  overview: "Your workspace at a glance.",
  markets: "A familiar market. A different way to trade.",
  portfolio: "Everything you hold, in one view.",
  trade: "Price a trade. Turn it into a rule.",
  discover: "Find your next position.",
  strategies: "Good decisions start with a plan.",
  activity: "Every move, in one place.",
  settings: "Make yourself at home.",
};

/**
 * One entry per section, and every one of them reads from an endpoint the API serves.
 *
 * "Automations" and "Signals" used to sit here. Automations was a second name for the same
 * /v1/instances object Strategies already shows, and Signals had no endpoint at all — it was
 * rendered entirely from a fixtures file.
 */
const navigation = [
  { href: "/", section: "overview", label: "Overview", icon: LayoutGrid },
  { href: "/markets", section: "markets", label: "Markets", icon: ChartNoAxesCombined },
  { href: "/portfolio", section: "portfolio", label: "Portfolio", icon: PieChart },
  { href: "/trade", section: "trade", label: "Trade", icon: Activity },
  { href: "/strategies", section: "strategies", label: "Strategies", icon: SlidersHorizontal },
  { href: "/activity", section: "activity", label: "Activity", icon: Activity },
  { href: "/discover", section: "discover", label: "Discover", icon: Compass },
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
  // Every section gets the heading. It used to be limited to four, which is why the Overview had
  // no "New strategy" button at all: the only control that reached the real editor was inside a
  // block that section never rendered.
  const {
    router,
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
        <Link href={"/"} className="brand">
          <span>
            <Mark />
          </span>
          mandate<span className="brand-period">.</span>
        </Link>
        <div className="workspace-switch">
          <span className="workspace-avatar">P</span>
          <span>
            Personal workspace<small>Base network</small>
          </span>
          <span className="network-dot" />
        </div>
        <div className="nav-caption">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobile(false)}
              className={section === item.section ? "nav-item active" : "nav-item"}
              aria-current={section === item.section ? "page" : undefined}
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
            openEditor();
          }}
        >
          <Plus size={17} />
          New strategy<span>↗</span>
        </button>
        <div className="sidebar-bottom">
          <button type="button" className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            Help & shortcuts
            <ArrowUpRight size={14} className="trailing" />
          </button>
          <Link
            href={"/settings"}
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
            onClick={session.authenticated ? () => router.push("/settings") : login}
          >
            <span className="account-avatar">
              <Wallet size={18} />
            </span>
            <span>
              {session.wallet ? shortAddress(session.wallet) : "Your wallet"}
              <small>{session.authenticated ? "Connected" : "Log in to get started"}</small>
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
            <span className="topbar-divider" />
            <AccountMenu
              session={session}
              onSignOut={() => void model.signOut()}
              onNavigate={(path) => router.push(path)}
              onCopied={setToast}
            />
          </div>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {section === "markets" || section === "discover"
                  ? "ONCHAIN EQUITIES"
                  : "YOUR WORKSPACE"}
              </div>
              <h1>
                {
                  {
                    ...sectionTitles,
                    strategies: model.detailPage ? (detail?.name ?? "Strategy") : "Your strategies",
                  }[section]
                }
              </h1>
              <p>
                {
                  (
                    {
                      ...sectionSubtitles,
                      strategies: model.detailPage
                        ? "Your rule, limits, and recorded activity."
                        : "Good decisions start with a plan.",
                    } satisfies Record<WorkspaceSection, string>
                  )[section]
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
          {error && !detail && (
            <div role="alert" className="error-banner">
              {error}
              <button type="button" onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {section === "overview" && <OverviewView model={model} />}
          {section === "markets" && (
            <MarketsView model={model} strategyRow={strategyRow} empty={empty} />
          )}
          {section === "trade" && <TerminalView model={model} />}
          {section === "portfolio" && <PortfolioView model={model} />}
          {section === "discover" && <DiscoverView model={model} />}
          {section === "strategies" && !model.detailPage && (
            <StrategiesView model={model} strategyRow={strategyRow} empty={empty} />
          )}
          {model.detailPage && <StrategyDetails model={model} />}
          {model.detailPage && !detail && !error && (
            <p className="helper">
              {session.authenticated ? "Loading strategy…" : "Log in to view this strategy."}
            </p>
          )}
          {section === "activity" && <ActivityView model={model} empty={empty} />}
          {section === "settings" && <SettingsView model={model} />}
          <footer className="workspace-footer">
            <span>
              <i className="base-dot" />
              On Base. On your terms.
            </span>
            <span>Your wallet. Your rules.</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={15} />
          </span>
          {toast}
        </div>
      )}
      {editor && (
        <StrategyEditor
          symbol={selected}
          initialMode={model.initialMode}
          // The builder asked for a target price and showed nothing to judge it against. These
          // already existed on the model and were simply never passed down.
          price={model.price}
          priceStale={model.priceStale}
          onClose={() => setEditor(false)}
          call={call}
          sign={session.sign}
          onCreate={(strategy) => {
            setEditor(false);
            if (strategy) setStrategies((current) => [strategy, ...current]);
            else void fetchOwned();
            setToast("Strategy saved. Ready when you are.");
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
              Wallet sign-in is not configured in this environment, so there is no way to
              authenticate right now. Markets, prices and charts are public and work without a
              wallet; anything that holds or moves funds needs one.
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setConnect(false);
                router.push("/markets");
              }}
            >
              Browse the market
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
                    router.push(`/trade?symbol=${symbol}`);
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
