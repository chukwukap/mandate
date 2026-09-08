"use client";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Loader2,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { currency, shortAddress } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { companies, stocks } from "../market/catalog";
import { DeskChart } from "../market/desk-chart";
import { StockLogo } from "../market/stock-logo";
import type { Strategy } from "../strategies/types";
import { money } from "../trading/market-data";
import { type Holding, usePortfolio } from "./use-portfolio";

/**
 * The landing page: what Mandate is, and where this account stands right now.
 *
 * Every figure below is served. Equity, cash and holdings come from `GET /v1/portfolio` through
 * `usePortfolio`; prices and the tradability notice from `GET /v1/market` through the workspace
 * model; the sparklines from `GET /v1/market/candles`; strategy counts from `GET /v1/instances`.
 *
 * The version this replaced opened with a portfolio value, an unrealised gain and four strategy
 * "presets" that were all fixtures — the first screen of the product was also the least true one.
 * Nothing here is computed from a number the API did not send, which is why there is no P&L: the
 * API reports what a wallet holds and what it is worth, never what it cost, and a cost basis
 * cannot be inferred from a balance.
 */
export function OverviewView({ model }: { model: WorkspaceModel }) {
  const {
    session,
    call,
    market,
    marketError,
    strategies,
    executions,
    watching,
    loading,
    price,
    priceStale,
    login,
    openEditor,
    selected,
  } = model;
  const { portfolio, error, loading: balancesLoading } = usePortfolio(session, call);
  // Local to this page rather than `model.period`: the range chosen for the hero sparkline is a
  // glance, and it should not follow the reader over to the range they set on the market page.
  const [period, setPeriod] = useState("1W");

  const connected = session.authenticated && Boolean(session.wallet);
  // The newest tick across every strategy. `last_tick_at` is null until a strategy has been
  // evaluated once, so a fresh account correctly reports that nothing has looked yet.
  const newestTick = strategies
    .map((strategy) => strategy.last_tick_at)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  const lastLooked = newestTick ? new Date(newestTick).toLocaleTimeString() : "not yet";
  const priced = portfolio?.holdings.filter((holding) => holding.value !== null) ?? [];
  // The largest position is the only holding whose chart says something about this portfolio, so
  // it is the one the hero draws. Before a wallet is connected the chart still runs — candles are
  // public — on whichever symbol the workspace has selected.
  const largest = priced.reduce<Holding | null>(
    (best, holding) => (!best || Number(holding.value) > Number(best.value) ? holding : best),
    null,
  );
  const chartSymbol = largest?.symbol ?? selected;
  const staleHoldings = portfolio?.holdings.filter((holding) => holding.stale) ?? [];

  return (
    <div>
      <div className="overview-hero-grid">
        <section className="capital-panel">
          <div className="capital-top">
            <span>
              <Wallet size={14} />
              {connected ? "Portfolio value" : "Your portfolio"}
              {connected && balancesLoading && !portfolio && <Loader2 size={13} className="spin" />}
            </span>
            <span className="capital-badge">
              <i />
              {portfolio
                ? `BASE · ${new Date(portfolio.as_of).toLocaleTimeString()}`
                : "BASE · USDC"}
            </span>
          </div>
          <div className="capital-value">
            {connected ? (
              <>
                {portfolio ? money(portfolio.equity) : balancesLoading ? "Reading…" : "—"}
                <span>USD</span>
              </>
            ) : (
              <>
                Not connected
                <span>balances need a wallet</span>
              </>
            )}
          </div>
          <div className="capital-performance">
            {connected ? (
              <>
                <span>{portfolio ? `${money(portfolio.cash)} in USDC` : "Reading balances"}</span>
                {/*
                  An em dash, not 0. `portfolio` is null both during the first read and
                  permanently after a failed one, and "0 positions" under a banner that says
                  balances are unavailable is a statement about the wallet that this page has no
                  basis for. Zero and unknown are the same pixel and not the same fact.
                */}
                <span>
                  {portfolio
                    ? `${portfolio.holdings.length} position${portfolio.holdings.length === 1 ? "" : "s"} · ${shortAddress(portfolio.wallet)}`
                    : "— positions"}
                </span>
              </>
            ) : (
              <>
                <button type="button" className="desk-button primary" onClick={login}>
                  <Wallet size={15} />
                  Log in
                </button>
                <span>Markets, prices and charts below are public.</span>
              </>
            )}
          </div>
          <div className="capital-chart">
            <DeskChart dark symbol={chartSymbol} period={period} />
          </div>
          <div className="capital-foot">
            <span>
              <i />
              {chartSymbol}
              {largest ? " · your largest holding" : " · observed on Base"}
            </span>
            <div className="desk-periods">
              {["1D", "1W", "1M", "1Y"].map((value) => (
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
            </div>
          </div>
        </section>
        {/*
          What is running, not what the product is.
          //
          This slot held the marketing explainer — "A rule you sign. A market you stop watching."
          — which is landing-page copy. It has a landing page: /welcome, which every first-time
          visitor passes through via OnboardingGate. Repeating the pitch inside the workspace
          spends the most valuable panel on screen telling a signed-in user what they already
          bought, next to the one number they came to see.
          //
          So this reports the state of their automation instead: how many rules are watching,
          whether the executor is actually able to act, and when it last looked.
        */}
        <section className="next-move-panel">
          <div className="next-move-top">
            <span className="desk-overline">WHAT IS RUNNING</span>
            <ArrowUpRight size={19} />
          </div>
          <h2>
            {watching.length === 0
              ? "Nothing is watching yet."
              : `${watching.length} ${watching.length === 1 ? "rule is" : "rules are"} watching.`}
          </h2>
          <p>
            {watching.length === 0
              ? "A strategy watches the market on your behalf and only ever acts inside the limits you signed."
              : `${strategies.length} total · last looked ${lastLooked}`}
          </p>

          <dl className="overview-runtime">
            <div>
              <dt>Executor</dt>
              {/*
                The worker's own heartbeat, not a guess. False here is the honest answer that an
                armed automatic strategy will record its decisions and not place an order.
              */}
              <dd>
                <span className={`desk-status ${market?.execution_available ? "armed" : "paused"}`}>
                  <i />
                  {market?.execution_available ? "Available" : "Observation only"}
                </span>
              </dd>
            </div>
            <div>
              <dt>Armed</dt>
              <dd>
                {watching.length}
                <small> / {strategies.length}</small>
              </dd>
            </div>
            <div>
              <dt>Decisions recorded</dt>
              <dd>{strategies.reduce((total, strategy) => total + strategy.orders, 0)}</dd>
            </div>
          </dl>

          <button
            type="button"
            className="desk-button dark"
            onClick={() => (connected ? openEditor() : login())}
          >
            {connected ? "Author a strategy" : "Log in to start"}
            <ArrowRight size={16} />
          </button>
          <div className="studio-footnote">Your keys · your caps · your kill switch</div>
        </section>
      </div>

      {error && (
        <div className="desk-error" role="alert">
          {error}
        </div>
      )}

      {/*
        Zeros before a wallet is connected would read as "you hold nothing", which is a claim this
        page cannot make about an address it has never seen. Nothing is served until then, so
        nothing is stated — the hero above carries the connect prompt instead.
      */}
      {connected && (
        <section className="desk-quick-stats" aria-label="Account summary">
          <div>
            <span>Available cash</span>
            <strong>{portfolio ? money(portfolio.cash) : "—"}</strong>
            <small>USDC on Base</small>
          </div>
          <div>
            <span>Positions</span>
            <strong>{portfolio ? portfolio.holdings.length : "—"}</strong>
            <small>
              {portfolio?.unpriced.length
                ? `${portfolio.unpriced.length} without a reference price`
                : "tokenized stocks held"}
            </small>
          </div>
          <div>
            <span>Watching the market</span>
            <strong>
              {watching.length}
              <small> / {strategies.length}</small>
            </strong>
            <small>armed of your strategies</small>
          </div>
          <div>
            <span>Orders recorded</span>
            <strong>
              {strategies.reduce((total: number, strategy: Strategy) => total + strategy.orders, 0)}
            </strong>
            <small>across your strategies</small>
          </div>
        </section>
      )}

      <section className="desk-section">
        <div className="desk-section-heading">
          <div>
            <span className="desk-overline">ONCHAIN EQUITIES</span>
            <h2>The market, right now.</h2>
          </div>
          <Link className="desk-text-link" href={"/markets"}>
            All markets
            <ArrowUpRight size={15} />
          </Link>
        </div>
        <div className="desk-market-strip">
          {stocks.map((symbol) => (
            <Link key={symbol} href={`/trade?symbol=${symbol}`} className="desk-market-tile">
              <div>
                <StockLogo symbol={symbol} />
                <span>
                  <strong>{companies[symbol]?.name ?? symbol}</strong>
                  <small>{symbol} / USDC</small>
                </span>
                <ArrowUpRight size={14} />
              </div>
              <div className="desk-market-tile-bottom">
                <strong>{currency(price(symbol))}</strong>
                {/*
                  A held close is labelled, never withheld. These are equity feeds with no
                  weekend heartbeat, so hiding stale readings blanks the whole strip from Friday
                  to Monday — the number is real, and saying how old it is costs one word.
                */}
                <span className="desk-muted">
                  {price(symbol) === undefined
                    ? "No reference"
                    : priceStale(symbol)
                      ? "Last close"
                      : "Reference"}
                </span>
              </div>
              <DeskChart compact symbol={symbol} />
            </Link>
          ))}
        </div>
        <span className="desk-bottom-note">
          {marketError
            ? "Reference prices are unavailable right now — reconnecting."
            : market
              ? market.execution_available
                ? "Reference prices from the onchain feeds. Routing is live, so a signed strategy can fill."
                : "Reference prices from the onchain feeds. Routed execution is unavailable right now, so strategies will record signals rather than fill."
              : "Loading reference prices…"}
        </span>
      </section>

      <div className="overview-lower-grid">
        <section className="desk-surface">
          <div className="desk-section-heading inset">
            <div>
              <span className="desk-overline">WORKING FOR YOU</span>
              <h2>Your strategies</h2>
            </div>
            <Link className="desk-text-link" href={"/strategies"}>
              All strategies
              <ArrowUpRight size={15} />
            </Link>
          </div>
          {strategies.length ? (
            strategies.slice(0, 4).map((strategy: Strategy) => (
              <Link
                key={strategy.id}
                className="overview-bot-row"
                href={`/strategies/${strategy.id}`}
              >
                <span className="mini-strategy-icon">
                  <SlidersHorizontal size={17} />
                </span>
                <div>
                  <strong>{strategy.name}</strong>
                  <small>
                    {strategy.assets?.length ? `${strategy.assets.map((s) => s.replace("c", "")).join(", ")} · ` : ""}
                    {strategy.mode === "auto" ? "Automatic" : "Manual"}
                    {strategy.last_tick_at
                      ? ` · checked ${new Date(strategy.last_tick_at).toLocaleString()}`
                      : " · not checked yet"}
                  </small>
                </div>
                <span>
                  {money(strategy.spent)}
                  <small>of {money(strategy.lifetime)} spent</small>
                </span>
                {/* `armed` has no tone of its own in the stylesheet; `running` is its green. */}
                <span
                  className={`desk-status ${strategy.status === "armed" ? "running" : strategy.status}`}
                >
                  <i />
                  {strategy.status}
                </span>
              </Link>
            ))
          ) : loading ? (
            <div className="desk-empty">
              <Loader2 className="spin" />
              <p>Loading your strategies…</p>
            </div>
          ) : (
            <div className="desk-empty">
              <span className="desk-empty-icon">
                <ShieldCheck size={22} />
              </span>
              <h3>{connected ? "Nothing is watching yet." : "Your strategies live here."}</h3>
              <p>
                {connected
                  ? "Pick a stock, a price, and a budget. The rule does the waiting."
                  : "Log in to author one and to see the strategies you already have."}
              </p>
              <button
                type="button"
                className="desk-button secondary"
                onClick={() => (connected ? openEditor() : login())}
              >
                {connected ? "Author a strategy" : "Log in"}
                <ArrowRight size={15} />
              </button>
            </div>
          )}
        </section>
        <section className="desk-surface">
          <div className="desk-section-heading inset">
            <div>
              <span className="desk-overline">WHAT HAPPENED</span>
              <h2>Recent activity</h2>
            </div>
            <Link className="desk-text-link" href={"/activity"}>
              All activity
              <ArrowUpRight size={15} />
            </Link>
          </div>
          {executions.length ? (
            executions.slice(0, 4).map((execution) => (
              <Link key={execution.id} className="overview-bot-row" href={"/activity"}>
                <span className="mini-strategy-icon tone-signal">
                  <ArrowDownLeft size={17} />
                </span>
                <div>
                  <strong>{execution.name ?? "Execution"}</strong>
                  <small>{new Date(execution.createdAt).toLocaleString()}</small>
                </div>
                <span>
                  {execution.intent?.amount ?? execution.amountIn}
                  <small>
                    {execution.intent
                      ? execution.intent.side === "buy"
                        ? "USDC"
                        : "tokens"
                      : "raw units"}
                  </small>
                </span>
                <span className={`desk-status ${execution.status}`}>
                  <i />
                  {execution.status}
                </span>
              </Link>
            ))
          ) : (
            /*
              Deliberately not "you have no activity". `useExecutions` only fetches for the
              activity section, so an empty list here means "not loaded", and this page has no
              standing to say a wallet has never traded. It points at the page that does know.
            */
            <div className="desk-empty">
              <span className="desk-empty-icon">
                <ArrowDownLeft size={22} />
              </span>
              <h3>Every fill, in one place.</h3>
              <p>Signals and orders your strategies record are listed on the Activity page.</p>
              <Link className="desk-text-link" href={"/activity"}>
                Open activity
                <ArrowRight size={15} />
              </Link>
            </div>
          )}
        </section>
      </div>

      {portfolio && (
        <span className="desk-bottom-note">
          {portfolio.notice}
          {portfolio.unpriced.length
            ? ` Not priced, so excluded from equity: ${portfolio.unpriced.join(", ")}.`
            : ""}
          {staleHoldings.length
            ? ` Priced from a held last close: ${staleHoldings.map((holding) => holding.symbol).join(", ")}.`
            : ""}
        </span>
      )}
    </div>
  );
}
