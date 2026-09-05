import { companies } from "./catalog";

export function StockLogo({ symbol, small = false }: { symbol: string; small?: boolean }) {
  const company = companies[symbol];
  return (
    <span
      aria-hidden="true"
      className={`asset-logo ${small ? "small" : ""} ${company?.color ?? "apple"}`}
    >
      {company?.letter ?? symbol.slice(0, 1)}
    </span>
  );
}
