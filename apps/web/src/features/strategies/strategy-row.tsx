import { MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { Status } from "../../components/status";
import { currency } from "../../lib/format";
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
        <span className="strategy-symbol">
          <SlidersHorizontal size={17} />
        </span>
        <span>
          <strong>{strategy.name}</strong>
          <small>
            {full
              ? (strategy.rule ??
                `${strategy.mode === "auto" ? "Automatic" : "Signal only"} · ${strategy.orders} orders`)
              : `${strategy.mode === "auto" ? "Automatic" : "Signal only"} · ${currency(strategy.lifetime)} budget`}
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
