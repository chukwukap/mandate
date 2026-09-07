"use client";

import { ArrowUpRight, Check, LogOut, Settings2, Wallet } from "lucide-react";
import { Status } from "../../components/status";
import { shortAddress } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { ThemeChoices } from "./theme-control";

export function SettingsView({
  model,
}: {
  model: Pick<
    WorkspaceModel,
    | "router"
    | "session"
    | "market"
    | "setStrategies"
    | "setExecutions"
    | "compact"
    | "setCompact"
    | "setToast"
    | "login"
  >;
}) {
  const {
    router,
    session,
    market,
    setStrategies,
    setExecutions,
    compact,
    setCompact,
    setToast,
    login,
  } = model;
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
            <p>{session.wallet ? shortAddress(session.wallet) : "No wallet connected"}</p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={
              session.authenticated
                ? async () => {
                    await session.logout();
                    setStrategies([]);
                    setExecutions([]);
                    setToast("Signed out");
                  }
                : login
            }
          >
            {session.authenticated ? (
              <>
                <LogOut size={15} />
                Sign out
              </>
            ) : (
              "Log in"
            )}
          </button>
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
                </option>
              ))}
            </select>
          </label>
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
                ? "Worker available. Each strategy needs its own approval."
                : "Currently unavailable. Signal strategies can still run."}
            </p>
          </div>
          <Status status={market?.execution_available ? "armed" : "paused"} />
        </div>
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
