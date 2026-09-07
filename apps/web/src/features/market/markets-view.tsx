"use client";
import { ArrowDownUp, ArrowRight, ArrowUpRight, Search, ShieldCheck, Star } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { currency } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { StockLogo } from "../market/stock-logo";
import type { Strategy } from "../strategies/types";
import { companies, stocks } from "./catalog";
import { DeskChart } from "./desk-chart";
import { MarketChart } from "./market-chart";
import type { CandleInterval } from "./use-candles";

export function MarketsView({
  model,
  strategyRow,
  empty,
}: {
  model: Pick<
    WorkspaceModel,
    | "priceStale"
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
    price,
    priceStale,
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
              {/*
                No percentage here. There was a `demoChanges` table with four of the seven
                symbols in it, so three cards printed "undefined%" and none of the numbers came
                from anywhere. What the reference genuinely knows is its own age.
              */}
              <small>{priceStale(symbol) ? "Last close" : "Reference price"}</small>
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
              <p className="quiet">
                {marketError
                  ? "Market data is temporarily unavailable"
                  : price(selected)
                    ? priceStale(selected)
                      ? "Last recorded close"
                      : "Latest available reference"
                    : "Waiting for market data"}
              </p>
            </div>
            {/*
              Every one of these was `disabled={!preview}` and the panel only ever rendered
              outside preview, so the whole range switcher was permanently dead. The values are
              the intervals /v1/market/candles actually serves.
            */}
            <fieldset className="segmented periods" aria-label="Chart range">
              {(["15m", "1H", "4H", "1D", "1W"] as CandleInterval[]).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={period === value ? "active" : ""}
                  aria-pressed={period === value}
                  onClick={() => setPeriod(value)}
                >
                  {value}
                </button>
              ))}
            </fieldset>
          </div>
          {/*
            The real chart. This branch used to say "Price history isn't available yet" to every
            signed-in user while the candles endpoint was serving real Aerodrome OHLCV the whole
            time — the working chart was in the preview branch, which this panel never took.
          */}
          <MarketChart symbol={selected} interval={period as CandleInterval} average height={300} />
          <div className="feature-bottom">
            <div>
              <span className="reference-dot" /> Observed trades · Aerodrome
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
            <Link href={"/strategies"} className="icon-button" aria-label="View all strategies">
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
                {strategies.slice(0, 3).map((strategy: Strategy) => strategyRow(strategy))}
              </div>
              <Link className="all-strategies" href={"/strategies"}>
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
              {visibleStocks.map((symbol) => (
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
                    <span className="quiet">{priceStale(symbol) ? "Last close" : "Live"}</span>
                  </td>
                  <td>
                    <DeskChart compact symbol={symbol} period="1D" />
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
            {marketError ? "Reconnecting to market data" : "References refresh every 30s"}
            <span className={`tiny-dot ${marketError ? "amber" : ""}`} />
          </span>
        </div>
      </section>
    </>
  );
}
