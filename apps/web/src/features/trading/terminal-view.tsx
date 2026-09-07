"use client";
import {
  ArrowUpRight,
  CandlestickChart,
  ChevronDown,
  LineChart,
  Loader2,
  ShieldCheck,
  Star,
  Wallet,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { currency } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { companies, stocks } from "../market/catalog";
import { MarketChart } from "../market/market-chart";
import { StockLogo } from "../market/stock-logo";
import type { Market } from "../market/types";
import type { CandleInterval } from "../market/use-candles";
import { usePortfolio } from "../portfolio/use-portfolio";

/**
 * The trade page: pricing and authoring for one market.
 *
 * It does not place orders, because nothing in this product does. There is no order endpoint —
 * a trade is authored as a strategy, signed by the owner, and executed by the worker — so the
 * page prices a route and then hands the reader to the editor. The paper ticket that used to
 * live here promised a fill the backend could never produce.
 *
 * Prices and the chart come from the public `/v1/market` and `/v1/market/candles` (via
 * `model.price` and `MarketChart`), tradability from the `catalogue` block of the same market
 * response, wallet balances from `GET /v1/portfolio`, and the routed quote from
 * `POST /v1/market/quote`. Only the last two need a wallet; everything else renders for a
 * first-time visitor.
 */

const INTERVALS: CandleInterval[] = ["15m", "1H", "4H", "1D", "1W"];
/** USDC is the quote token for every pair in the catalogue, and it is a 6-decimal token. */
const USDC_DECIMALS = 6;
/** The router accepts 1-500 bps. These are the three sizes worth putting in front of a human. */
const SLIPPAGE_CHOICES = [10, 50, 100];

/** `MarketBlocker` from the API, in words. An unknown code falls back to the server's `detail`. */
const BLOCKERS: Record<string, string> = {
  "reference-unavailable": "No reference price",
  "reference-stale": "Reference too old to check a quote against",
  "no-priced-route": "No priced route at probe size",
  "quote-deviation": "Venue price outside the reference band",
  "chain-unavailable": "Chain unreachable",
};

/** The response of `POST /v1/market/quote`: a `Quote` plus the checked price and deviation. */
type RoutedQuote = {
  symbol: string;
  decimals: number;
  amount_in: string;
  amount_out: string;
  min_out: string;
  tick_spacing: number;
  expires_at: string;
  reference: string;
  price: string;
  deviation_bps: string;
};

/** One priced answer, tagged with the request it belongs to. Either `quote` or `error` is set. */
type QuoteResult = {
  symbol: string;
  side: "buy" | "sell";
  slippage: number;
  quote: RoutedQuote | null;
  error: string;
};

/** What the catalogue says about one symbol's tradability, reduced to what this page shows. */
type Tradability = {
  tradable: boolean;
  reason: string | null;
  detail: string | null;
  probePrice: string | null;
  deviationBps: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * The `catalogue` entry for one symbol, read defensively.
 *
 * `/v1/market` serves `catalogue` alongside `feeds`, but features/market/types.ts models only
 * the keys the rest of the app reads and this view does not own that file. Rather than assert a
 * shape onto the response, the block is validated here: a missing or reshaped catalogue costs
 * this panel and nothing else on the page.
 */
function tradabilityFor(market: Market | null, symbol: string): Tradability | null {
  const block: unknown = (market as unknown as { catalogue?: unknown } | null)?.catalogue;
  if (!Array.isArray(block)) return null;
  const entries: unknown[] = block;
  const entry = entries.find((item) => isRecord(item) && item.symbol === symbol);
  if (!isRecord(entry)) return null;
  const probe = isRecord(entry.quote) ? entry.quote : null;
  return {
    tradable: entry.tradable === true,
    reason: text(entry.reason),
    detail: text(entry.detail),
    probePrice: probe ? text(probe.price) : null,
    deviationBps: text(entry.deviation_bps),
  };
}

/** The terms the catalogue probe was taken on, and when the snapshot was read. */
type Probe = {
  amount: string | null;
  side: string | null;
  note: string | null;
  asOf: string | null;
};

/** Read the same way and for the same reason as `tradabilityFor`: additive keys, validated. */
function probeFor(market: Market | null): Probe | null {
  const response = market as unknown as { probe?: unknown; as_of?: unknown } | null;
  if (!response) return null;
  const block = isRecord(response.probe) ? response.probe : null;
  return {
    amount: block ? text(block.amount) : null,
    side: block ? text(block.side) : null,
    note: block ? text(block.note) : null,
    asOf: text(response.as_of),
  };
}

/**
 * A raw integer token amount to whole units, exactly.
 *
 * Quote amounts arrive as base-unit integers against tokens of 6 and 8 decimals. Dividing by a
 * power of ten in float64 loses the tail of a share quantity, so the point is moved by string
 * surgery instead and nothing is rounded away.
 */
function units(raw: string, decimals: number) {
  if (!/^\d+$/.test(raw)) return null;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals ? padded.slice(padded.length - decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

const amountText = (raw: string, decimals: number) => units(raw, decimals) ?? "—";

export function TerminalView({ model }: { model: WorkspaceModel }) {
  const {
    market,
    marketError,
    selected,
    setSelected,
    price,
    priceStale,
    session,
    call,
    favorites,
    toggleStar,
    openEditor,
    login,
  } = model;
  const [interval, chooseInterval] = useState<CandleInterval>("1D");
  const [chart, setChart] = useState<"candles" | "line">("candles");
  const [average, setAverage] = useState(true);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(50);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [pending, setPending] = useState(false);
  const { portfolio, error: portfolioError } = usePortfolio(session, call);

  const walletReady = session.authenticated && Boolean(session.wallet);
  const tradability = tradabilityFor(market, selected);
  const probe = probeFor(market);
  const stale = priceStale(selected);
  const asset = market?.assets.find((entry) => entry.symbol === selected);
  // The API validates precision itself; the fallback only has to be permissive enough not to
  // block a legitimate amount while the catalogue is still loading.
  const amountDecimals = side === "buy" ? USDC_DECIMALS : (asset?.decimals ?? 18);
  const entered = amount.trim();
  const amountValid =
    /^\d{1,30}(\.\d{1,18})?$/.test(entered) &&
    /[1-9]/.test(entered) &&
    (entered.split(".")[1]?.length ?? 0) <= amountDecimals;
  const holding = portfolio?.holdings.find((item) => item.symbol === selected);
  const available = side === "buy" ? portfolio?.cash : holding?.quantity;

  // An answer belongs to the symbol and side it was priced for. Rather than clear it from an
  // effect when the form changes, it is simply not shown once it stops describing the form —
  // there is then no frame in which a NVDAc quote sits under an AAPLc ticket.
  const shown = result && result.symbol === selected && result.side === side ? result : null;

  const requestQuote = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    const context = { symbol: selected, side, slippage };
    try {
      const quoted = await call<RoutedQuote>("/v1/market/quote", {
        symbol: selected,
        side,
        amount: entered,
        slippage_bps: slippage,
      });
      setResult({ ...context, quote: quoted, error: "" });
    } catch (error) {
      setResult({
        ...context,
        quote: null,
        error: error instanceof Error ? error.message : "The quote could not be priced.",
      });
    } finally {
      setPending(false);
    }
  };

  const quote = shown?.quote ?? null;
  const inDecimals = side === "buy" ? USDC_DECIMALS : (quote?.decimals ?? amountDecimals);
  const outDecimals = side === "buy" ? (quote?.decimals ?? amountDecimals) : USDC_DECIMALS;
  const inLabel = side === "buy" ? "USDC" : selected;
  const outLabel = side === "buy" ? selected : "USDC";

  return (
    <div>
      <div className="desk-page-title">
        <div>
          <span className="desk-overline">PRICING DESK</span>
          <h1>
            Price the route, then write the rule<span>.</span>
          </h1>
          <p>
            Observed trades, the reference price, and a real routed quote for one market. No order
            is placed here — a trade runs as a strategy you sign.
          </p>
        </div>
        <button type="button" className="desk-button primary" onClick={() => openEditor(selected)}>
          Turn this into a strategy
          <ArrowUpRight size={16} />
        </button>
      </div>

      <div className="terminal-market-bar">
        <label className="terminal-pair">
          <StockLogo symbol={selected} />
          <div>
            <select
              aria-label="Market"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {stocks.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol} / USDC
                </option>
              ))}
            </select>
            <small>{companies[selected]?.name ?? selected} · Tokenized stock</small>
          </div>
          <ChevronDown size={16} />
        </label>
        <button
          type="button"
          className={`desk-icon-button ${favorites.includes(selected) ? "favorited" : ""}`}
          aria-label={`${favorites.includes(selected) ? "Remove" : "Add"} ${selected} watchlist`}
          onClick={() => toggleStar(selected)}
        >
          <Star size={18} fill={favorites.includes(selected) ? "currentColor" : "none"} />
        </button>
        <div className="terminal-quote">
          <strong>{currency(price(selected))}</strong>
          {/* The number is shown whatever its age; `stale` changes the label, never the value. */}
          <span className="desk-muted">
            {price(selected)
              ? stale
                ? "Reference · held last close"
                : "Reference price"
              : marketError
                ? "Market data unavailable"
                : "Waiting for market data"}
          </span>
        </div>
        <div className="terminal-market-stat">
          <span>Settlement</span>
          <strong>USDC</strong>
        </div>
        <div className="terminal-market-stat">
          <span>Network</span>
          <strong>Base</strong>
        </div>
      </div>

      <div className="terminal-layout">
        <div className="terminal-chart-column">
          <section className="desk-surface terminal-chart-panel">
            <div className="terminal-chart-toolbar">
              <div className="desk-periods">
                {INTERVALS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={interval === value ? "active" : ""}
                    aria-pressed={interval === value}
                    onClick={() => chooseInterval(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <div className="chart-tools">
                <button
                  type="button"
                  className={chart === "candles" ? "active" : ""}
                  aria-label="Candlestick chart"
                  aria-pressed={chart === "candles"}
                  onClick={() => setChart("candles")}
                >
                  <CandlestickChart size={16} />
                </button>
                <button
                  type="button"
                  className={chart === "line" ? "active" : ""}
                  aria-label="Line chart"
                  aria-pressed={chart === "line"}
                  onClick={() => setChart("line")}
                >
                  <LineChart size={16} />
                </button>
                <span />
                <button
                  type="button"
                  className={average ? "active" : ""}
                  aria-pressed={average}
                  onClick={() => setAverage(!average)}
                >
                  MA 20
                </button>
              </div>
            </div>
            <div className="terminal-chart-brand">
              <span>{interval} candles · Aerodrome pool trades</span>
              <span>{selected} / USDC</span>
            </div>
            {/* Remounted per series type: the chart swaps its series on the library side. */}
            <MarketChart
              key={`${selected}-${chart}`}
              symbol={selected}
              interval={interval}
              type={chart}
              average={average}
            />
            <div className="terminal-chart-bottom">
              <span>
                <i />
                Observed Aerodrome trades · refreshed every 30s
              </span>
              <span>{marketError ? "Reconnecting to market data" : "Prices in USDC"}</span>
            </div>
          </section>

          <section className="desk-surface">
            <div className="desk-section-heading inset">
              <h2>This market right now</h2>
              <span className="desk-muted">From the catalogue probe</span>
            </div>
            <div className="desk-table-scroll">
              <table className="desk-table">
                <tbody>
                  <tr>
                    <td>Reference price</td>
                    <td>
                      {currency(price(selected))}
                      {stale && <small>Held last close</small>}
                    </td>
                  </tr>
                  <tr>
                    <td>Probe price</td>
                    <td>
                      {tradability?.probePrice ? currency(tradability.probePrice) : "—"}
                      {probe?.amount && probe.side && (
                        <small>
                          {probe.amount} USDC exact-input {probe.side}
                        </small>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td>Probe deviation from reference</td>
                    <td>{tradability?.deviationBps ? `${tradability.deviationBps} bps` : "—"}</td>
                  </tr>
                  <tr>
                    <td>Tradable now</td>
                    <td>
                      {tradability
                        ? tradability.tradable
                          ? "Yes"
                          : ((tradability.reason && BLOCKERS[tradability.reason]) ?? "No")
                        : "—"}
                    </td>
                  </tr>
                  <tr>
                    <td>Execution worker</td>
                    <td>{market ? (market.execution_available ? "Online" : "Offline") : "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="desk-table-footer">
              <span>{tradability?.detail ?? probe?.note ?? "Catalogue probe"}</span>
              <span>{probe?.asOf ? `Read ${new Date(probe.asOf).toLocaleTimeString()}` : ""}</span>
            </div>
          </section>
        </div>

        <section className="desk-surface order-ticket">
          <div className="ticket-heading">
            <h2>Routed quote</h2>
            <span className="desk-muted">Read-only</span>
          </div>
          {tradability && !tradability.tradable && (
            <p className="desk-error">
              {tradability.detail ??
                (tradability.reason && BLOCKERS[tradability.reason]) ??
                "This market cannot be routed right now."}
            </p>
          )}
          {walletReady ? (
            <form onSubmit={requestQuote}>
              <div className="ticket-side">
                <button
                  type="button"
                  className={`buy ${side === "buy" ? "active" : ""}`}
                  aria-pressed={side === "buy"}
                  onClick={() => setSide("buy")}
                >
                  Buy
                </button>
                <button
                  type="button"
                  className={`sell ${side === "sell" ? "active" : ""}`}
                  aria-pressed={side === "sell"}
                  onClick={() => setSide("sell")}
                >
                  Sell
                </button>
              </div>
              <div className="ticket-available">
                <span>In your wallet</span>
                {available ? (
                  <button
                    type="button"
                    className="desk-text-link"
                    title="Use the whole balance"
                    onClick={() => setAmount(available)}
                  >
                    {available} {inLabel}
                  </button>
                ) : (
                  <b>{portfolioError ? "Balances unavailable" : "—"}</b>
                )}
              </div>
              <label className="desk-field">
                {side === "buy" ? "Amount to spend" : "Shares to sell"}
                <span className="desk-input-unit ticket-amount">
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={side === "buy" ? "Amount in USDC" : `Amount in ${selected}`}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                  <span>{inLabel}</span>
                </span>
              </label>
              <label className="desk-field">
                Maximum slippage
                <select
                  value={slippage}
                  onChange={(event) => setSlippage(Number(event.target.value))}
                >
                  {SLIPPAGE_CHOICES.map((bps) => (
                    <option key={bps} value={bps}>
                      {bps} bps · {(bps / 100).toFixed(2)}%
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="desk-button primary full ticket-submit"
                disabled={!amountValid || pending}
              >
                {pending ? <Loader2 size={15} className="spin" /> : null}
                {pending ? "Pricing…" : "Get a routed quote"}
              </button>
              {shown?.error && <p className="desk-error">{shown.error}</p>}
              {quote ? (
                <>
                  <div className="ticket-estimate">
                    <span>Routed price</span>
                    <strong>
                      {currency(quote.price)}
                      <small>per {quote.symbol}</small>
                    </strong>
                  </div>
                  <div className="ticket-details">
                    <div>
                      <span>You {side === "buy" ? "pay" : "sell"}</span>
                      <span>
                        {amountText(quote.amount_in, inDecimals)} {inLabel}
                      </span>
                    </div>
                    <div>
                      <span>You receive</span>
                      <span>
                        {amountText(quote.amount_out, outDecimals)} {outLabel}
                      </span>
                    </div>
                    <div>
                      <span>Minimum at {shown?.slippage ?? slippage} bps</span>
                      <span>
                        {amountText(quote.min_out, outDecimals)} {outLabel}
                      </span>
                    </div>
                    <div>
                      <span>Checked against</span>
                      <span>{currency(quote.reference)}</span>
                    </div>
                    <div>
                      <span>Deviation</span>
                      <span>{quote.deviation_bps} bps</span>
                    </div>
                    <div>
                      <span>Pool tick spacing</span>
                      <span>{quote.tick_spacing}</span>
                    </div>
                    <div>
                      <span>Quote expires</span>
                      <span>{new Date(quote.expires_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </>
              ) : (
                <p className="ticket-footnote">
                  A quote reads the router at this size. It reserves nothing and moves nothing.
                </p>
              )}
            </form>
          ) : (
            <div className="desk-empty">
              <span className="desk-empty-icon">
                <Wallet size={20} />
              </span>
              <h3>Connect a wallet to price a route</h3>
              <p>
                The chart and the reference price above are public. A routed quote is priced for
                your own wallet, so it needs one connected.
              </p>
              <button type="button" className="desk-button primary" onClick={login}>
                Connect wallet
              </button>
            </div>
          )}
          <div className="ticket-protection-heading">
            <span>
              <ShieldCheck size={15} />
              Nothing executes from this page
            </span>
          </div>
          <button
            type="button"
            className="desk-button secondary full"
            onClick={() => openEditor(selected)}
          >
            Turn this into a strategy
            <ArrowUpRight size={15} />
          </button>
          <p className="ticket-footnote">
            You sign a strategy, arm it, and the worker executes it against your spending
            permission. Funds move at that point and not before.
          </p>
        </section>
      </div>

      <section className="terminal-other-markets">
        <span>OTHER MARKETS</span>
        {stocks
          .filter((symbol) => symbol !== selected)
          .map((symbol) => (
            <button
              key={symbol}
              type="button"
              title={priceStale(symbol) ? "Reference held at its last close" : "Reference price"}
              onClick={() => setSelected(symbol)}
            >
              <StockLogo symbol={symbol} small />
              <strong>{symbol}</strong>
              <span>
                {currency(price(symbol))}
                {priceStale(symbol) ? " · held" : ""}
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
      </section>
      <p className="desk-bottom-note">
        Reference prices come from Chainlink feeds and can hold the last close while the underlying
        market is shut — those are marked. Quotes come from the live Aerodrome router and expire. A
        quote is not a trade authorization.
      </p>
    </div>
  );
}
