import { MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { Status } from "../../components/status";
import { currency } from "../../lib/format";
import { StockLogo } from "../market/stock-logo";
import type { Strategy } from "./types";
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
              strategy.assets?.length ? strategy.assets.map((s) => s.replace("c", "")).join(", ") : null,
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
            <i
              style={{
                width: `${Math.min(100, (Number(strategy.spent) / Math.max(1, Number(strategy.lifetime))) * 100)}%`,
              }}
            />
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
