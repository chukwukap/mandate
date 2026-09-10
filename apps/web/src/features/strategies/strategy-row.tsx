import { MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { Status } from "../../components/status";
import { currency } from "../../lib/format";
import { StockLogo } from "../market/stock-logo";
import type { Strategy } from "./types";
/**
 * How much of the signed budget is spent, as a percentage, or zero when that is not known.
 *
 * The arithmetic this replaces was `Math.min(100, spent / Math.max(1, lifetime) * 100)`, and
 * `Math.max(1, NaN)` is NaN rather than 1 — so a strategy missing either figure produced
 * `width: NaN%`, which CSS discards, leaving the bar at its natural full width. A row we had no
 * numbers for rendered as a fully spent budget, which is the most alarming thing it could have
 * said and the one thing we did not know.
 */
export function budgetFilled(spent: unknown, lifetime: unknown): number {
  const used = Number(spent);
  const cap = Number(lifetime);
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.max(0, Math.min(100, (used / cap) * 100));
}

export function StrategyRow({
  strategy,
  full = false,
  openDetail,
}: {
  strategy: Strategy;
  full?: boolean;
  openDetail(strategy: Strategy): void;
}) {
  return (
    <div className={`strategy-row ${full ? "full" : ""}`} key={strategy.id}>
      <button type="button" className="strategy-main" onClick={() => openDetail(strategy)}>
        {/* The stocks themselves, not a generic icon. A seven-name basket and a single-stock
            ladder used to render identically here, which made the list unreadable at a glance
            for exactly the strategies that most need distinguishing. */}
        <span className="strategy-symbol">
          {strategy.assets?.length ? (
            <span className="strategy-assets">
              {strategy.assets.slice(0, 3).map((symbol) => (
                <StockLogo key={symbol} symbol={symbol} small />
              ))}
              {strategy.assets.length > 3 && <i>+{strategy.assets.length - 3}</i>}
            </span>
          ) : (
            <SlidersHorizontal size={17} />
          )}
        </span>
        <span>
          <strong>{strategy.name}</strong>
          <small>
            {[
              strategy.mode === "auto" ? "Automatic" : "Signal only",
              strategy.assets?.length
                ? strategy.assets.map((s) => s.replace("c", "")).join(", ")
                : null,
              full ? `${strategy.orders} orders` : `${currency(strategy.lifetime)} budget`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
      </button>
      {full && (
        <div className="budget-cell">
          <span>
            {currency(strategy.spent)} <small>/ {currency(strategy.lifetime)}</small>
          </span>
          <div className="budget-track">
            <i style={{ width: `${budgetFilled(strategy.spent, strategy.lifetime)}%` }} />
          </div>
        </div>
      )}
      <Status status={strategy.status} />
      {full ? (
        <button
          type="button"
          className="icon-button"
          aria-label={`Open ${strategy.name}`}
          onClick={() => openDetail(strategy)}
        >
          <MoreHorizontal size={19} />
        </button>
      ) : null}
    </div>
  );
}
