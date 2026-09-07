"use client";
import { ArrowUpRight, ChevronDown, Search, ShieldCheck, Star, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { currency } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { companies } from "../market/catalog";
import { DeskChart } from "../market/desk-chart";
import { StockLogo } from "../market/stock-logo";

/**
 * The Discover page: everything the API actually lists, one card per asset.
 *
 * Every value here comes from `GET /v1/market` by way of `model.market` — the catalogue
 * (`assets`), its reference feeds (`model.price` / `model.priceStale`) and the worker heartbeat
 * (`execution_available`). The sparklines are `GET /v1/market/candles`, drawn by `DeskChart`.
 * `companies` supplies display names and logos only; it never supplies a number.
 *
 * This page used to be a library of invented "strategy profiles" with sample returns, drawdowns
 * and win rates behind them. Nothing served those numbers, so the page taught readers to trust
 * figures the product could not stand behind. What replaced it is the one thing the catalogue
 * genuinely answers: what is listed, what it costs, and whether it can be quoted right now.
 */
export function DiscoverView({ model }: { model: WorkspaceModel }) {
  const {
    market,
    marketError,
    price,
    priceStale,
    favorites,
    toggleStar,
    openEditor,
    session,
    login,
  } = model;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("All listings");
  const [sort, setSort] = useState("Company A–Z");

  const assets = market?.assets ?? [];
  const name = (symbol: string) => companies[symbol]?.name ?? symbol;
  // Number(undefined) is NaN, which is exactly the "no reference" case, so one comparator
  // covers both price sorts and always sinks unpriced assets rather than floating them to
  // the top of a descending list as zeros.
  const byPrice = (a: string, b: string, descending: boolean) => {
    const left = Number(price(a));
    const right = Number(price(b));
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return descending ? right - left : left - right;
  };
  const listed = assets
    .filter((asset) => scope !== "Watchlist" || favorites.includes(asset.symbol))
    .filter((asset) =>
      `${asset.symbol} ${name(asset.symbol)}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => {
      if (sort === "Price, high to low") return byPrice(a.symbol, b.symbol, true);
      if (sort === "Price, low to high") return byPrice(a.symbol, b.symbol, false);
      if (sort === "Watchlist first")
        return Number(favorites.includes(b.symbol)) - Number(favorites.includes(a.symbol));
      return name(a.symbol).localeCompare(name(b.symbol));
    });

  const priced = assets.filter((asset) => price(asset.symbol) !== undefined);
  const held = priced.filter((asset) => priceStale(asset.symbol));
  const starred = assets.filter((asset) => favorites.includes(asset.symbol));
  const routing = market?.execution_available ?? false;

  return (
    <div className="discover-view">
      <div className="desk-page-title">
        <div>
          <span className="desk-overline">WHAT IS LISTED</span>
          <h1>
            Everything you can trade here<span>.</span>
          </h1>
          <p>
            Coinbase B20 tokenised equities on Base. The price on each card is the Chainlink
            total-return reference for the underlying share; the trend line beneath it is trades
            observed on Aerodrome, where these tokens actually change hands.
          </p>
        </div>
      </div>

      {/*
        The catalogue is public, so a visitor with no wallet still gets the whole page. What they
        cannot do is star, quote or author, and saying so with the connect button attached beats
        letting them find out by pressing something that silently opens a login.
      */}
      {!session.authenticated && (
        <div className="portfolio-cash">
          <span className="cash-icon">
            <Wallet size={19} />
          </span>
          <div>
            <span>Browsing without a wallet</span>
            <strong>Prices and charts are public</strong>
          </div>
          <button type="button" className="desk-button primary" onClick={login}>
            Log in
            <ArrowUpRight size={15} />
          </button>
        </div>
      )}

      {market && (
        <div className="desk-quick-stats">
          <div>
            <span>Listed assets</span>
            <strong>{assets.length}</strong>
            <small>Tokenised equities on Base</small>
          </div>
          <div>
            <span>Live references</span>
            <strong>{priced.length - held.length}</strong>
            <small>Feeds updated within the reference window</small>
          </div>
          <div>
            <span>Held closes</span>
            <strong>{held.length}</strong>
            <small>Last close, carried while the session is shut</small>
          </div>
          <div>
            <span>Routing</span>
            <strong>{routing ? "Available" : "Paused"}</strong>
            <small>Execution worker heartbeat</small>
          </div>
        </div>
      )}

      <div className="discover-controls">
        <div className="desk-inline-search">
          <Search size={16} />
          <input
            aria-label="Search the catalogue"
            placeholder="Find a company or symbol…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div>
          <label className="desk-filter-select">
            <select
              aria-label="Filter the catalogue"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              {["All listings", "Watchlist"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <ChevronDown size={14} />
          </label>
          <label className="desk-filter-select">
            <select
              aria-label="Sort the catalogue"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              {["Company A–Z", "Price, high to low", "Price, low to high", "Watchlist first"].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
            <ChevronDown size={14} />
          </label>
        </div>
      </div>

      <section className="desk-section">
        <div className="desk-section-heading">
          <div>
            <span className="desk-overline">THE CATALOGUE</span>
            <h2>{market ? `${listed.length} of ${assets.length} listed` : "Listed assets"}</h2>
          </div>
          <span className="desk-muted">
            {starred.length} on your watchlist<span> · </span>Prices in USD
          </span>
        </div>

        {!market ? (
          <div className="desk-surface">
            <div className="desk-empty">
              <span className="desk-empty-icon">
                <ShieldCheck size={22} />
              </span>
              <h3>{marketError ? "The catalogue is unreachable." : "Loading the catalogue…"}</h3>
              <p>
                {marketError
                  ? "The market service did not answer. Nothing is guessed in its place; this page retries every 30 seconds."
                  : "Reading the listed assets and their reference feeds."}
              </p>
            </div>
          </div>
        ) : listed.length ? (
          <div className="desk-market-strip">
            {listed.map((asset) => {
              const symbol = asset.symbol;
              const reference = price(symbol);
              const stale = priceStale(symbol);
              const saved = favorites.includes(symbol);
              return (
                <article key={symbol} className="desk-market-tile">
                  <div>
                    <StockLogo symbol={symbol} />
                    <span>
                      <strong>{name(symbol)}</strong>
                      <small>{symbol} / USDC</small>
                    </span>
                    {/*
                      The stylesheet right-aligns a bare <svg> in this row, not a button, and this
                      file may not add a rule to desk.css — so the one property that would have
                      been a class lives here.
                    */}
                    <button
                      type="button"
                      style={{ marginLeft: "auto" }}
                      className={`desk-icon-button ${saved ? "favorited" : ""}`}
                      aria-label={`${saved ? "Remove" : "Add"} ${symbol} ${saved ? "from" : "to"} watchlist`}
                      onClick={() => toggleStar(symbol)}
                    >
                      <Star size={15} fill={saved ? "currentColor" : "none"} />
                    </button>
                  </div>
                  <div className="desk-market-tile-bottom">
                    {/* A held close is still the asset's most recent real price, so it is shown
                        at full size and the tag below says what it is. */}
                    <strong>{currency(reference)}</strong>
                    <span className="desk-muted">Reference</span>
                  </div>
                  <div className="signal-tags">
                    <span>
                      {reference && !stale && <i />}
                      {reference ? (stale ? "Held close" : "Live reference") : "No reference"}
                    </span>
                    {/*
                      `execution_available` is the whole market's flag — the catalogue carries no
                      per-asset tradability — but a quote is rejected when it cannot be checked
                      against a reference, so an unpriced asset is genuinely not quotable.
                    */}
                    <span>
                      {!routing ? "Routing paused" : reference ? "Quotable" : "Not quotable"}
                    </span>
                  </div>
                  <DeskChart compact symbol={symbol} />
                  <div className="profile-card-foot">
                    <Link className="desk-text-link" href={`/trade?symbol=${symbol}`}>
                      Trade {symbol}
                      <ArrowUpRight size={14} />
                    </Link>
                    <button
                      type="button"
                      className="desk-button secondary"
                      onClick={() => openEditor(symbol)}
                    >
                      Set a rule
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="desk-surface">
            <div className="desk-empty">
              <span className="desk-empty-icon">
                <Search size={22} />
              </span>
              <h3>{assets.length ? "Nothing matches that." : "Nothing is listed."}</h3>
              <p>
                {assets.length
                  ? "Try a different search, or switch back to all listings."
                  : "The catalogue came back empty. Every asset this app can trade comes from it, so there is nothing to show."}
              </p>
              {Boolean(assets.length) && (
                <button
                  type="button"
                  className="desk-button secondary"
                  onClick={() => {
                    setQuery("");
                    setScope("All listings");
                  }}
                >
                  Clear the filters
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* The same admission the API makes in its own reference_notice, kept where a reader is
          looking at the prices it qualifies. */}
      <div className="discovery-note">
        <ShieldCheck size={17} />
        <p>
          Reference feeds can hold the last close during closed sessions or corporate-action pauses,
          and those prices are marked “Held close” above rather than hidden. Trend lines are pool
          trades on Aerodrome, not the underlying exchange. A quote is not a trade authorization.
        </p>
      </div>
    </div>
  );
}
