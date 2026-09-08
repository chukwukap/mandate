import type { ShapeId } from "./shapes";

/**
 * A mark per strategy shape: what its ORDERS look like, drawn in a few strokes.
 *
 * Five options that differ only in their text read as a paragraph to skim; five options that
 * each carry a distinct picture read as a choice. These are schematics of the order pattern —
 * where the buys land relative to price — which is the thing the engine actually does, not a
 * chart of history, which it cannot read. All strokes use currentColor so the same glyph sits
 * correctly on a card, in a chip, and against either theme.
 */
export function ShapeGlyph({ shape, size = 40 }: { shape: ShapeId; size?: number }) {
  const common = {
    width: size,
    height: Math.round(size * 0.7),
    viewBox: "0 0 40 28",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (shape) {
    case "levels":
      // Price wanders down through a level; the buy is the dot where it crosses.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M2 17 H38" strokeDasharray="2.5 3" opacity="0.55" />
          <path d="M3 6 C 10 6, 13 12, 18 14 S 27 20, 37 22" />
          <circle cx="23.5" cy="17" r="2.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "recurring":
      // The same buy, evenly spaced, indifferent to the price line drifting above it.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 9 C 12 4, 20 12, 37 8" opacity="0.45" />
          {[6, 13, 20, 27, 34].map((x) => (
            <path key={x} d={`M${x} 24 V16`} strokeWidth="3" />
          ))}
        </svg>
      );
    case "ladder":
      // Steps down and bars that grow: each rung lower, each buy larger.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 5 H11 V10 H19 V15 H27 V20 H37" opacity="0.55" />
          <path d="M7 24 V21" strokeWidth="3" />
          <path d="M15 24 V19" strokeWidth="3" />
          <path d="M23 24 V16" strokeWidth="3" />
          <path d="M31 24 V12" strokeWidth="3" />
        </svg>
      );
    case "rebalance":
      // Three holdings brought back to one line; the short one is the one that gets topped up.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M5 8 H35" strokeDasharray="2.5 3" opacity="0.55" />
          <path d="M10 24 V8" strokeWidth="4" />
          <path d="M20 24 V15" strokeWidth="4" />
          <path d="M20 15 V8" strokeWidth="4" strokeDasharray="1.5 2.5" opacity="0.7" />
          <path d="M30 24 V8" strokeWidth="4" />
        </svg>
      );
    case "discount":
      // The reference above, the pool below it, and the gap between them is the trade.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 9 H37" />
          <path d="M3 18 C 10 19, 18 15, 37 17" strokeDasharray="2.5 3" opacity="0.7" />
          <path d="M20 10 V16" />
          <path d="M17.5 13.5 L20 16 L22.5 13.5" />
        </svg>
      );
  }
}
