"use client";

import { ArrowUpRight, Check, Copy, LogOut, Settings2, Wallet } from "lucide-react";
import { useState } from "react";
import { Status } from "../../components/status";
import { shortAddress } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { ThemeChoices } from "./theme-control";

export function SettingsView({
  model,
}: {
  model: Pick<
    WorkspaceModel,
    "router" | "session" | "market" | "compact" | "setCompact" | "setToast" | "login" | "signOut"
  >;
}) {
  const { router, session, market, compact, setCompact, setToast, login, signOut } = model;
  const { automation } = session;
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The account address is the embedded wallet: it is what strategies buy from and what a
  // deposit goes to, which is what a person opening Settings wants to check.
  const address = session.embeddedWallet ?? session.wallet;
  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setToast("Address copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setToast("Couldn't copy — select the address to copy it manually.");
    }
  };
  /**
   * One switch for the whole account. Either direction ends with the API re-reading the wallet,
   * so `automation.delegated` after this is the API's answer, not the button's assumption.
   */
  const toggleAutomation = async () => {
    setBusy(true);
    setError("");
    try {
      if (automation.delegated) await session.disableAutomation();
      else await session.enableAutomation();
      setToast(automation.delegated ? "Automatic buying turned off" : "Automatic buying turned on");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update automatic buying.");
    } finally {
      setBusy(false);
    }
  };
  const automationCopy = !session.authenticated
    ? "Log in to let strategies buy from your wallet."
    : automation.loading
      ? "Checking your wallet…"
      : !automation.supported
        ? "Not available for this account yet."
        : automation.delegated
          ? `On. Strategies set to buy automatically buy from ${shortAddress(automation.wallet ?? address ?? "")}.`
          : "Off. Strategies set to buy automatically record signals instead.";
  return (
    <div className="settings-grid">
      <section className="panel settings-panel appearance-panel">
        <div className="panel-heading">
          <h2>Appearance</h2>
        </div>
        <div className="appearance-content">
          <p>Make room for the way you work.</p>
          <ThemeChoices />
          <small>System follows your device. Your choice is remembered.</small>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading">
          <h2>Account</h2>
          <Wallet size={18} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Wallet</strong>
            <p>{address ? "Your wallet on Base. Send USDC here to fund it." : "No wallet yet"}</p>
          </div>
          {address ? (
            <div className="setting-address">
              <code>{address}</code>
              <button
                type="button"
                className="button secondary"
                onClick={() => void copy()}
                aria-label="Copy wallet address"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <button type="button" className="button secondary" onClick={login}>
              Log in
            </button>
          )}
        </div>
        {session.wallets.length > 1 && (
          <label className="setting-wallet">
            Active wallet
            <select
              value={session.wallet ?? ""}
              onChange={(e) => session.selectWallet(e.target.value)}
            >
              {session.wallets.map((wallet) => (
                <option key={wallet} value={wallet}>
                  {shortAddress(wallet)}
                  {wallet === session.embeddedWallet ? " · Mandate wallet" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="setting-row">
          <div>
            <strong>Automatic buying</strong>
            <p>{automationCopy}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={automation.delegated}
            aria-label="Automatic buying"
            className={`toggle ${automation.delegated ? "on" : ""}`}
            disabled={busy || automation.loading || !automation.supported}
            onClick={() => void toggleAutomation()}
          >
            <span />
          </button>
        </div>
        {error && (
          <p className="form-error setting-error" role="alert">
            {error}
          </p>
        )}
        <div className="setting-row">
          <div>
            <strong>Network</strong>
            <p>All stock strategies run on Base.</p>
          </div>
          <span className="base-label">
            <i />
            Base
          </span>
        </div>
        <div className="setting-row">
          <div>
            <strong>Automatic execution</strong>
            <p>
              {market?.execution_available
                ? "Worker available. Strategies with automatic buying on will fill."
                : "Currently unavailable. Signal strategies can still run."}
            </p>
          </div>
          <Status status={market?.execution_available ? "armed" : "paused"} />
        </div>
        {session.authenticated && (
          <div className="setting-row">
            <div>
              <strong>Session</strong>
              <p>Signing out keeps your wallet and strategies as they are.</p>
            </div>
            <button
              type="button"
              className="button secondary"
              // The same routine the header menu calls. This used to be a second, slightly
              // different implementation with no error handling of its own.
              onClick={() => void signOut()}
            >
              <LogOut size={15} />
              Sign out
            </button>
          </div>
        )}
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading">
          <h2>Workspace</h2>
          <Settings2 size={18} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Compact rows</strong>
            <p>A little more room for your watchlist.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={compact}
            aria-label="Compact rows"
            className={`toggle ${compact ? "on" : ""}`}
            onClick={() => setCompact(!compact)}
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>Getting started</strong>
            <p>Revisit your introduction to Mandate.</p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => router.push("/welcome")}
          >
            View onboarding
            <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>Motion</strong>
            <p>Automatically follows your device's reduced-motion setting.</p>
          </div>
          <Check size={18} className="green" />
        </div>
      </section>
    </div>
  );
}
