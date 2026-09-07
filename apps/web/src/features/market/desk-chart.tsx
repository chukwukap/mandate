"use client";
import { useId } from "react";
import { type CandleInterval, useCandles } from "./use-candles";

/**
 * A compact sparkline of real observed trades.
 *
 * It used to draw `candlesFor(symbol, period)` — 64 candles generated from a sine wave and the
 * symbol's first character. The shape was convincing and meant nothing, which is worse than no
 * chart at all next to a real price: a reader has no way to tell which half of the row is true.
 *
 * Now it draws the same Aerodrome OHLCV the full `MarketChart` draws, from the same cached
 * endpoint, so a row's sparkline and the chart it opens agree.
 *
 * # Why this stays hand-rolled SVG
 *
 * A market page renders one of these per row. Eight lightweight-charts instances to draw eight
 * 90px trend lines is a cost with nothing bought by it — the crosshair, the zoom and the price
 * scale that justify the library at full size are all absent here by design.
 */

const PERIOD_INTERVALS: Record<string, CandleInterval> = {
  "1D": "15m",
  "1W": "1H",
  "1M": "4H",
  "1Y": "1D",
};

export function DeskChart({
  symbol = "NVDAc",
  period = "1D",
  dark = false,
  compact = false,
  target,
}: {
  symbol?: string;
  period?: string;
  dark?: boolean;
  compact?: boolean;
  target?: number | undefined;
}) {
  const gradient = useId().replaceAll(":", "");
  const { candles, error } = useCandles(symbol, PERIOD_INTERVALS[period] ?? "1H");

  const width = 800;
  const height = compact ? 90 : 280;
  const left = 8;
  const right = compact ? 8 : 65;
  const bottom = compact ? 0 : 24;

  // Two points is the minimum that describes a line. Below that there is nothing honest to draw,
  // and the caller is told which of the two reasons applies.
  if (!candles || candles.length < 2) {
    return (
      <div
        className={`desk-chart is-empty ${dark ? "is-dark" : ""} ${compact ? "is-compact" : ""}`}
      >
        <span className="desk-muted">
          {error ?? (candles ? "No trades in this window." : "Loading…")}
        </span>
      </div>
    );
  }

  const closes = candles.map((candle) => candle.close);
  const lo = Math.min(...closes) * 0.998;
  const hi = Math.max(...closes) * 1.002;
  const span = hi - lo || 1;
  const x = (index: number) => left + (index * (width - left - right)) / (candles.length - 1);
  const y = (price: number) => (height - bottom - 12) * (1 - (price - lo) / span) + 6;
  const line = candles.map((c, i) => `${i ? "L" : "M"}${x(i)},${y(c.close)}`).join(" ");
  const last = candles[candles.length - 1] as { close: number };
  const first = candles[0] as { close: number };
  const rising = last.close >= first.close;
  const stroke = rising ? (dark ? "#c9eaa6" : "#2f7858") : "#b3382f";

  return (
    <div className={`desk-chart ${dark ? "is-dark" : ""} ${compact ? "is-compact" : ""}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${symbol} observed price, ${period}`}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity=".21" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {!compact &&
          [0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line
                x1={left}
                x2={width - right + 6}
                y1={y(lo + (span * i) / 4)}
                y2={y(lo + (span * i) / 4)}
                className="chart-grid"
              />
              <text
                x={width - right + 15}
                y={y(lo + (span * i) / 4) + 4}
                className="chart-axis-text"
              >
                {(lo + (span * i) / 4).toFixed(2)}
              </text>
            </g>
          ))}
        <path
          d={`${line} L${x(candles.length - 1)},${height - bottom} L${left},${height - bottom}Z`}
          fill={`url(#${gradient})`}
        />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth={compact ? 2 : 2.5}
          strokeLinejoin="round"
        />
        {target !== undefined && target >= lo && target <= hi && (
          <g>
            <line
              x1={left}
              x2={width - right}
              y1={y(target)}
              y2={y(target)}
              stroke="#b5974c"
              strokeDasharray="5 4"
            />
            <text x={left + 4} y={y(target) - 7} className="chart-axis-text">
              Your level · {target.toFixed(2)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
