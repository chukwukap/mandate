"use client";
import { useState } from "react";
import { companies } from "./catalog";

/**
 * The token's own mark, falling back to a coloured initial.
 *
 * The fallback is not decoration. A logo can fail for reasons the page cannot control — a
 * symbol this catalogue has never seen, a file that did not deploy — and an asset row with a
 * hole where its identity should be reads as a broken app. Swapping to the initial on `error`
 * keeps the row the same shape and the same size whatever happens.
 *
 * `<img>` rather than next/image deliberately: these are fixed 128px squares served from our
 * own public directory, so the optimiser has nothing to optimise, and next/image would add a
 * loader indirection between a broken file and the fallback below.
 */
export function StockLogo({ symbol, small = false }: { symbol: string; small?: boolean }) {
  const company = companies[symbol];
  const [failed, setFailed] = useState(false);
  const className = `asset-logo ${small ? "small" : ""} ${company?.color ?? "apple"}`;

  if (company?.logo && !failed) {
    return (
      <img
        className={`${className} has-image`}
        src={company.logo}
        // Decorative: every caller already renders the symbol and company name as text beside
        // this, so announcing the logo again would only repeat what a screen reader just said.
        alt=""
        aria-hidden="true"
        width={small ? 26 : 34}
        height={small ? 26 : 34}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span aria-hidden="true" className={className}>
      {company?.letter ?? symbol.slice(0, 1)}
    </span>
  );
}
