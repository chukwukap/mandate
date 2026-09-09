"use client";
import { ArrowUpRight, Loader2, Plus, RefreshCw, Wallet } from "lucide-react";
import { useState } from "react";
import { shortAddress } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { companies } from "../market/catalog";
import { StockLogo } from "../market/stock-logo";
import { money } from "../trading/market-data";
import { DepositCard } from "./deposit-card";
import { type Holding, usePortfolio } from "./use-portfolio";

/**
 * What the connected wallet actually holds, from `GET /v1/portfolio` and nothing else.
 *
 * Every figure on this page — quantity, price, value, cash, equity — is a field of that one
 * response. There is no portfolio history endpoint, so there is no equity curve here: a chart of
 * a total we have never recorded could only be drawn by inventing the past.
 */

/** Token amounts, not money: six places is where the smallest listed position stops rounding away. */
const units = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const quantity = (value: string) =>
  Number.isFinite(Number(value)) ? units.format(Number(value)) : value;

/**
 * Largest position first, unpriced last.
 *
 * A holding with no price has no value to rank by, and floating it to the top on a `null` would
 * put the one row we know least about above the ones the reader came for.
 */
function byValue(a: Holding, b: Holding) {
  if (a.value === null || b.value === null)
    return Number(a.value === null) - Number(b.value === null);
  return Number(b.value) - Number(a.value);
}

export function PortfolioView({ model }: { model: WorkspaceModel }) {
  const { session, login, openEditor, call, setToast } = model;
  const { portfolio, error, loading, refresh, ready } = usePortfolio(session, call);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const createWallet = async () => {
    if (creatingWallet) return;
    setCreatingWallet(true);
    try {
      await session.createTradingWallet();
    } catch {
      setToast("Your trading wallet couldn't be created. Please try again.");
    } finally {
      setCreatingWallet(false);
    }
  };
  /**
   * Where to send money, above everything else on the page.
   *
   * The embedded wallet is the strategy account, so it is the address shown even when the user
   * is looking at a linked external wallet's balances. The balance on the card is only claimed
   * when the reading below is for that same address; otherwise it says nothing rather than
   * showing one wallet's cash under another wallet's address.
   */
  const depositAddress = session.embeddedWallet;
  const deposit = depositAddress ? (
    <DepositCard
      address={depositAddress}
      balance={
        portfolio && portfolio.wallet.toLowerCase() === depositAddress.toLowerCase()
          ? portfolio.cash
          : null
      }
      notify={setToast}
    />
  ) : session.authenticated ? (
    <section className="deposit-card" aria-label="Trading wallet setup">
      <div className="deposit-head">
        <h2>Your trading wallet</h2>
      </div>
      <p>Create your embedded wallet to receive USDC on Base and use it for your strategies.</p>
      <button
        type="button"
        className="button primary"
        disabled={!session.ready || creatingWallet}
        onClick={() => void createWallet()}
      >
        {creatingWallet ? "Creating wallet…" : "Create trading wallet"}
      </button>
    </section>
  ) : null;

  // Kept above every early return so a failed poll never replaces a reading that is already on
  // screen — a balance a minute old is a better answer than an empty panel.
  const banner = error ? (
    <div role="alert" className="error-banner">
      {error}
      <button
        type="button"
        className="text-button"
        disabled={loading}
        onClick={() => void refresh()}
      >
        Try again
        <RefreshCw size={14} />
      </button>
    </div>
  ) : null;

  if (!session.ready)
    return (
      <section className="panel">
        <div className="loading-state">
          <Loader2 className="spin" />
          Checking your wallet
        </div>
      </section>
    );

  // The endpoint answers for the caller's own linked wallets and refuses any other address, so
  // without one there is nothing to fetch. That is a state, not a failure.
  if (!ready)
    return (
      <section className="panel">
        <div className="empty-state">
          <span className="empty-icon">
            <Wallet size={23} />
          </span>
          <h3>Your holdings stay in your wallet.</h3>
          <p>
            Connect it and this page reads your balances straight off Base. Markets and prices are
            public and need no wallet at all.
          </p>
          <button type="button" className="button primary" onClick={() => login()}>
            <Wallet size={15} />
            Log in
          </button>
        </div>
      </section>
    );

  if (!portfolio)
    return (
      <>
        {banner}
        {deposit}
        <section className="panel">
          {error ? (
            <div className="table-empty">No reading yet. Try again when you're ready.</div>
          ) : (
            <div className="loading-state">
              <Loader2 className="spin" />
              Reading your balances
            </div>
          )}
        </section>
      </>
    );

  const holdings = [...portfolio.holdings].sort(byValue);

  return (
    <>
      {banner}
      {deposit}
      <div className="stat-row">
        <div>
          <span>Portfolio value</span>
          <strong>{portfolio.equity === null ? "—" : money(portfolio.equity)}</strong>
          {portfolio.equity === null && (
            <p className="helper">
              No total:{" "}
              {portfolio.unpriced.length ? portfolio.unpriced.join(", ") : "part of this wallet"}{" "}
              could not be priced. The holdings that could are all below.
            </p>
          )}
        </div>
        <div>
          <span>Cash</span>
          <strong>
            {money(portfolio.cash)}
            <small>USDC</small>
          </strong>
        </div>
        <div>
          <span>Holdings</span>
          <strong>
            {portfolio.holdings.length}
            <small>{portfolio.holdings.length === 1 ? "asset" : "assets"}</small>
          </strong>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            Your holdings<span>{holdings.length}</span>
          </h2>
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "Reading…" : "Refresh"}
            <RefreshCw size={14} />
          </button>
        </div>
        {holdings.length ? (
          <div className="table-scroll">
            <table className="stocks-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Quantity</th>
                  <th>Price</th>
                  <th>Value</th>
                  <th>Reference</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => (
                  <tr key={holding.token}>
                    <td>
                      <span className="company-cell">
                        <StockLogo symbol={holding.symbol} />
                        <span>
                          <strong>{companies[holding.symbol]?.name ?? holding.symbol}</strong>
                          <small>{holding.symbol}</small>
                        </span>
                      </span>
                    </td>
                    <td className="number">{quantity(holding.quantity)}</td>
                    <td className="number">{money(holding.price)}</td>
                    <td className="number">{money(holding.value)}</td>
                    <td>
                      {/*
                        A held last close is labelled, never hidden. These are equity feeds with
                        no off-hours heartbeat, so from Friday's close to Monday's open every one
                        of them reads stale while the tokens keep trading — dropping the number
                        for that reason blanks the page for most of every week.
                      */}
                      {holding.price === null ? (
                        <span className="status halted">
                          <i />
                          No price
                        </span>
                      ) : holding.stale ? (
                        <span className="status paused">
                          <i />
                          Held close
                        </span>
                      ) : (
                        <span className="quiet">Current</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="row-action"
                        onClick={() => openEditor(holding.symbol)}
                      >
                        Set a rule
                        <ArrowUpRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">
              <Wallet size={23} />
            </span>
            <h3>Nothing held yet.</h3>
            <p>
              Holdings appear here as soon as this wallet holds a listed asset. A rule that buys on
              your terms is one way to get there.
            </p>
            <button type="button" className="button secondary" onClick={() => openEditor()}>
              <Plus size={15} />
              Create a strategy
            </button>
          </div>
        )}
        <div className="table-footer">
          <span>
            Last read {new Date(portfolio.as_of).toLocaleTimeString()}
            <span className="footer-dot">·</span>
            {shortAddress(portfolio.wallet)}
          </span>
          <span className="base-label">
            <i />
            {portfolio.chain_id === 8453 ? "Base" : `Chain ${portfolio.chain_id}`}
          </span>
        </div>
      </section>
      <p className="section-footnote">{portfolio.notice}</p>
    </>
  );
}
