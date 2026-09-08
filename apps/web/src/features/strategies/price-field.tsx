"use client";

import { companies } from "../market/catalog";
import { StockLogo } from "../market/stock-logo";

/**
 * A price a rule triggers at, entered next to the price it is being judged against.
 *
 * The field this replaces asked for a "Target price" with a `$0.00` placeholder and showed the
 * stock's current price nowhere on the screen. That is a form asking someone to answer a
 * question whose only reference lives somewhere else in the app, and every piece of research on
 * this builder named it the clearest defect in the flow.
 *
 * Percent is offered alongside dollars because a level is a judgement about a MOVE, not about an
 * absolute number: "8% below today" is a decision a person owns, and a copied "$169.46" is one
 * they cannot check. The chips write the dollar value, so what is shown is what gets signed.
 */
export function PriceField({
  symbol,
  spot,
  stale,
  value,
  direction,
  onChange,
}: {
  symbol: string;
  /** Today's oracle price, or undefined while the market is still loading. */
  spot: string | undefined;
  stale: boolean | undefined;
  value: string;
  direction: "lt" | "gt";
  onChange(value: string): void;
}) {
  const now = spot ? Number(spot) : undefined;
  const target = value ? Number(value) : undefined;
  const usable = now !== undefined && Number.isFinite(now) && now > 0;
  const delta =
    usable && target !== undefined && Number.isFinite(target) && target > 0
      ? ((target - (now as number)) / (now as number)) * 100
      : undefined;

  /** Below for a "falls below" rule, above for "rises above" — never a chip that cannot fire. */
  const steps = direction === "lt" ? [-3, -5, -10, -20] : [3, 5, 10, 20];
  const atStep = (pct: number) => ((now as number) * (1 + pct / 100)).toFixed(2);

  return (
    <div className="price">
      <div className="price-head">
        <StockLogo symbol={symbol} small />
        <strong>{symbol.replace("c", "")}</strong>
        <em>{companies[symbol]?.name}</em>
        {usable ? (
          <span className={`price-now ${stale ? "stale" : ""}`}>
            {stale ? "last close" : "now"} <b>${(now as number).toFixed(2)}</b>
          </span>
        ) : (
          <span className="price-now stale">no price yet</span>
        )}
      </div>
      <div className="field big">
        <div className="field-input">
          <i>$</i>
          <input
            required
            inputMode="decimal"
            // The placeholder is today's price, so an empty field still shows the scale of the
            // number being asked for rather than a meaningless 0.00.
            placeholder={usable ? (now as number).toFixed(2) : "0.00"}
            aria-label={`Trigger price for ${companies[symbol]?.name ?? symbol}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          {delta !== undefined && (
            <b className={`price-delta ${delta < 0 ? "down" : "up"}`}>
              {delta > 0 ? "+" : ""}
              {delta.toFixed(1)}%
            </b>
          )}
        </div>
      </div>
      {usable && (
        <div className="chips">
          {steps.map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => onChange(atStep(pct))}
              aria-pressed={value === atStep(pct)}
            >
              {pct > 0 ? "+" : ""}
              {pct}%
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
