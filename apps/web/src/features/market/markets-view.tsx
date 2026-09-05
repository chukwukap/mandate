"use client";
import {
  Activity,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  Search,
  ShieldCheck,
  Star,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { currency } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { PriceChart } from "../market/price-chart";
import { StockLogo } from "../market/stock-logo";
import type { Strategy } from "../strategies/types";
import { companies, stocks } from "./catalog";
import { demoChanges } from "./preview";

export function MarketsView({
  model,
  strategyRow,
  empty,
}: {
  model: Pick<
    WorkspaceModel,
    | "preview"
    | "marketError"
    | "strategies"
    | "selected"
    | "setSelected"
    | "period"
    | "setPeriod"
    | "filter"
    | "setFilter"
    | "query"
    | "setQuery"
    | "favorites"
    | "setSort"
    | "href"
    | "price"
    | "company"
    | "visibleStocks"
    | "watching"
    | "openEditor"
    | "toggleStar"
  >;
  strategyRow(strategy: Strategy, full?: boolean): ReactNode;
  empty(title: string, description: string, action?: boolean): ReactNode;
}) {
  const {
    preview,
    marketError,
    strategies,
    selected,
    setSelected,
    period,
    setPeriod,
    filter,
    setFilter,
    query,
    setQuery,
    favorites,
    setSort,
    href,
    price,
    company,
    visibleStocks,
    watching,
    openEditor,
    toggleStar,
  } = model;
  return (
    <>
      <div className="market-cards">
        {stocks.map((symbol) => (
          <button
            key={symbol}
            type="button"
            className={`market-card ${selected === symbol ? "selected" : ""}`}
            onClick={() => setSelected(symbol)}
            aria-pressed={selected === symbol}
          >
            <div className="market-card-head">
              <StockLogo symbol={symbol} small />
              <strong>
                {symbol}
                <small>{companies[symbol]?.name}</small>
              </strong>
              <ArrowUpRight size={15} />
            </div>
            <div className="market-card-price">
              <span>{currency(price(symbol))}</span>
              {preview ? (
                <span className={`change ${(demoChanges[symbol] ?? 0) < 0 ? "negative" : ""}`}>
                  {(demoChanges[symbol] ?? 0) > 0 ? "+" : ""}
                  {demoChanges[symbol]}%
                </span>
              ) : (
                <small>Reference price</small>
              )}
            </div>
          </button>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel featured">
          <div className="feature-top">
            <div className="stock-heading">
              <StockLogo symbol={selected} />
              <div>
                <h2>
                  {company?.name}
                  <span>{selected}</span>
                </h2>
                <p>
                  Tokenized stock <span>·</span> Base
                </p>
              </div>
            </div>
            <button
              type="button"
              className={`icon-button star-button ${favorites.includes(selected) ? "saved" : ""}`}
              aria-label={`${favorites.includes(selected) ? "Remove" : "Add"} ${selected} ${favorites.includes(selected) ? "from" : "to"} watchlist`}
              onClick={() => toggleStar(selected)}
            >
              <Star size={19} fill={favorites.includes(selected) ? "currentColor" : "none"} />
            </button>
          </div>
          <div className="feature-quote">
            <div>
              <div className="large-price" key={selected}>
                {currency(price(selected))}
                <span>USD</span>
              </div>
              {preview ? (
                <p className={`change ${(demoChanges[selected] ?? 0) < 0 ? "negative" : ""}`}>
                  <ArrowUpRight size={14} />{" "}
                  {currency((Number(price(selected)) * (demoChanges[selected] ?? 0)) / 100)} (
                  {demoChanges[selected]}%)<span>today</span>
                </p>
              ) : (
                <p className="quiet">
                  {marketError
                    ? "Market data is temporarily unavailable"
                    : price(selected)
                      ? "Latest available reference"
                      : "Waiting for market data"}
                </p>
              )}
            </div>
            <fieldset className="segmented periods" aria-label="Chart range">
              {["1D", "1W", "1M", "1Y", "ALL"].map((value) => (
                <button
                  type="button"
                  key={value}
                  className={period === value ? "active" : ""}
                  aria-pressed={period === value}
                  disabled={!preview}
                  onClick={() => setPeriod(value)}
                >
                  {value}
                </button>
              ))}
            </fieldset>
          </div>
          {preview ? (
            <PriceChart
              basePrice={Number(price(selected))}
              seed={stocks.indexOf(selected)}
              period={period}
            />
          ) : (
            <div className="chart-unavailable">
              <Activity size={28} />
              <span>Price history isn't available yet.</span>
              <small>Current references appear as data arrives.</small>
            </div>
          )}
          <div className="feature-bottom">
            <div>
              <span className="reference-dot" />{" "}
              {preview ? "Sample price history" : "Reference price"}
              <span className="bottom-separator">/</span>
              <span>USDC pair</span>
            </div>
            <button type="button" className="text-button" onClick={() => openEditor()}>
              Create a rule
              <ArrowRight size={15} />
            </button>
          </div>
        </section>
        <section className="panel strategy-panel">
          <div className="panel-heading">
            <h2>
              Your strategies<span>{strategies.length}</span>
            </h2>
            <Link
              href={href("/strategies")}
              className="icon-button"
              aria-label="View all strategies"
            >
              <ArrowUpRight size={18} />
            </Link>
          </div>
          {strategies.length ? (
            <>
              <div className="watching-summary">
                <span className="pulse-dot" />
                {watching.length} watching the market
              </div>
              <div className="strategy-list">
                {strategies.slice(0, 3).map((strategy) => strategyRow(strategy))}
              </div>
              <Link className="all-strategies" href={href("/strategies")}>
                View all strategies
                <ArrowRight size={15} />
              </Link>
            </>
          ) : (
            empty("Let your rules do the watching.", "Choose a stock, a price, and a budget.")
          )}
          <div className="strategy-note">
            <span className="note-icon">
              <ShieldCheck size={19} />
            </span>
            <div>
              <strong>Your limits come first.</strong>
              <p>You choose when, what, and how much.</p>
            </div>
          </div>
        </section>
      </div>
      <section className="panel stocks-panel">
        <div className="panel-heading stocks-heading">
          <div className="tabs">
            {["All stocks", "Watchlist"].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={filter === value ? "active" : ""}
              >
                {value}
                {value === "Watchlist" && <span>{favorites.length}</span>}
              </button>
            ))}
          </div>
          <label className="inline-search">
            <Search size={16} />
            <input
              aria-label="Filter stocks"
              placeholder="Find a stock…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span>/</span>
          </label>
        </div>
        <div className="table-scroll">
          <table className="stocks-table">
            <thead>
              <tr>
                <th aria-label="Watchlist" />
                <th>Company</th>
                <th>
                  <button type="button" onClick={() => setSort((value) => !value)}>
                    Price
                    <ArrowDownUp size={12} />
                  </button>
                </th>
                <th>24h change</th>
                <th>Price trend</th>
                <th>Network</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleStocks.map((symbol, index) => (
                <tr key={symbol}>
                  <td>
                    <button
                      type="button"
                      className={`icon-button table-star ${favorites.includes(symbol) ? "saved" : ""}`}
                      aria-label={`Toggle ${symbol} watchlist`}
                      onClick={() => toggleStar(symbol)}
                    >
                      <Star size={15} fill={favorites.includes(symbol) ? "currentColor" : "none"} />
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="company-cell"
                      onClick={() => {
                        setSelected(symbol);
                        document
                          .querySelector(".featured")
                          ?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                    >
                      <StockLogo symbol={symbol} />
                      <span>
                        <strong>{companies[symbol]?.name}</strong>
                        <small>{symbol}</small>
                      </span>
                    </button>
                  </td>
                  <td className="number">{currency(price(symbol))}</td>
                  <td>
                    <span className={`change ${(demoChanges[symbol] ?? 0) < 0 ? "negative" : ""}`}>
                      {preview
                        ? `${(demoChanges[symbol] ?? 0) > 0 ? "+" : ""}${demoChanges[symbol]}%`
                        : "—"}
                    </span>
                  </td>
                  <td>
                    {preview ? (
                      <PriceChart compact seed={index} basePrice={Number(price(symbol))} />
                    ) : (
                      <span className="quiet">—</span>
                    )}
                  </td>
                  <td>
                    <span className="base-label">
                      <i />
                      Base
                    </span>
                  </td>
                  <td>
                    <button type="button" className="row-action" onClick={() => openEditor(symbol)}>
                      Set a rule
                      <ArrowUpRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visibleStocks.length && (
            <div className="table-empty">No stocks found. Try a different search.</div>
          )}
        </div>
        <div className="table-footer">
          <span>
            {visibleStocks.length} stocks<span className="footer-dot">·</span>Prices in USD
          </span>
          <span>
            {preview
              ? "Sample data"
              : marketError
                ? "Reconnecting to market data"
                : "References refresh every 30s"}
            <span className={`tiny-dot ${marketError ? "amber" : ""}`} />
          </span>
        </div>
      </section>
    </>
  );
}
