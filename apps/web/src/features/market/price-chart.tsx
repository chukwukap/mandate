"use client";

import { useId, useState } from "react";
import { currency } from "../../lib/format";

const points = [
  15, 18, 16, 24, 20, 22, 28, 25, 26, 20, 23, 16, 19, 25, 24, 32, 29, 37, 30, 36, 33, 40, 34, 38,
  44, 40, 48, 42, 46, 50, 46, 59, 56, 61, 52, 58, 51, 55, 54, 65, 60, 66, 63, 69, 72, 66, 75, 71,
  78, 75, 83, 80, 85, 82, 87, 84, 90, 88, 85, 94,
];
export function PriceChart({
  basePrice,
  seed = 0,
  compact = false,
  period = "1D",
}: {
  basePrice: number;
  seed?: number;
  compact?: boolean;
  period?: string;
}) {
  const id = useId().replaceAll(":", "");
  const [hover, setHover] = useState<number | null>(null);
  const rangeSeed = ["1D", "1W", "1M", "1Y", "ALL"].indexOf(period) + 1;
  const values = points.map(
    (p, i) => (seed === 1 ? 110 - p : p) + Math.sin(i * (seed + rangeSeed)) * (4 + rangeSeed * 3),
  );
  const labels: Record<string, string[]> = {
    "1D": ["9:30 AM", "11:00 AM", "12:30 PM", "2:00 PM", "4:00 PM"],
    "1W": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    "1M": ["Week 1", "Week 2", "Week 3", "Week 4"],
    "1Y": ["Sep ’25", "Dec", "Mar", "Jun", "Sep ’26"],
    ALL: ["2022", "2023", "2024", "2025", "2026"],
  };
  const width = 700;
  const height = compact ? 48 : 222;
  const coords = values.map((p, i) => [
    (i / (values.length - 1)) * width,
    height - (p / 115) * (height - 12) - 6,
  ]);
  const line = coords.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const selected = hover === null ? undefined : coords[hover];
  return (
    <div className={compact ? "sparkline" : "price-chart"}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-label={compact ? "Sample price trend" : "Interactive illustrative price history"}
        role="img"
        onPointerMove={
          compact
            ? undefined
            : (event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setHover(
                  Math.max(
                    0,
                    Math.min(
                      points.length - 1,
                      Math.round(
                        ((event.clientX - bounds.left) / bounds.width) * (points.length - 1),
                      ),
                    ),
                  ),
                );
              }
        }
        onPointerLeave={() => setHover(null)}
      >
        <title>Illustrative price history</title>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--green)" stopOpacity=".12" />
            <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {!compact && (
          <>
            {[0.22, 0.52, 0.82].map((p) => (
              <line
                key={p}
                x1="0"
                x2={width}
                y1={height * p}
                y2={height * p}
                stroke="var(--line)"
                strokeDasharray="3 5"
              />
            ))}
            <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
          </>
        )}
        <path
          d={line}
          fill="none"
          stroke="var(--green)"
          strokeWidth={compact ? 1.5 : 2}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {selected && (
          <>
            <line
              x1={selected[0]}
              x2={selected[0]}
              y1="0"
              y2={height}
              stroke="var(--green)"
              strokeDasharray="3 4"
              opacity=".4"
            />
            <circle
              cx={selected[0]}
              cy={selected[1]}
              r="4"
              fill="var(--green)"
              stroke="var(--paper)"
              strokeWidth="3"
            />
          </>
        )}
      </svg>
      {!compact && hover !== null && (
        <div
          className="chart-tooltip"
          style={{ left: `${Math.max(10, Math.min(90, (hover / (points.length - 1)) * 100))}%` }}
        >
          {currency(basePrice * (0.94 + (values[hover] ?? 0) / 1500))}
          <small>Sample price</small>
        </div>
      )}
      {!compact && (
        <div className="chart-axis">
          {(labels[period] ?? labels["1D"])?.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}
    </div>
  );
}
