import { demoPrices } from "../market/preview";

/**
 * Live reference prices, keyed by symbol, published by useMarket.
 *
 * The demo workspace simulates positions and cash, but it should not invent PRICES: /v1/market
 * is public, needs no wallet, and answers with the real Chainlink reference for every listed
 * B20 equity. The fixtures had drifted badly against it — AAPLc was pinned at 237.49 while the
 * live reference was 320.08, a 26% error — so a visitor evaluating the product was shown a
 * market that does not exist.
 *
 * A module-level registry rather than a prop because demoQuote is called as a pure function from
 * a dozen components; threading a price argument through all of them would be a larger and more
 * fragile change than the problem warrants. Empty until the first response, so the fixtures still
 * render a coherent demo when the API is unreachable.
 */
const livePrices = new Map<string, number>();

/** Replaces the live set. Called on every market refresh; unknown symbols simply stay absent. */
export function publishLivePrices(prices: Iterable<readonly [string, number]>): void {
  livePrices.clear();
  for (const [symbol, value] of prices) {
    if (Number.isFinite(value) && value > 0) livePrices.set(symbol, value);
  }
}

/** Whether any live price has arrived, so the UI can say whether it is showing real prices. */
export function hasLivePrices(): boolean {
  return livePrices.size > 0;
}

/** The reference price for a symbol in dollars: live when known, fixture otherwise. */
function referencePrice(symbol: string): number {
  const live = livePrices.get(symbol);
  if (live !== undefined) return live;
  return Number(demoPrices[symbol] ?? "100");
}
export const usd = (cents: number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(cents / 100);
export function demoQuote(symbol: string, tick = 0) {
  // The wobble is what makes a paper fill feel like a market; the level underneath it is real.
  return Math.round(referencePrice(symbol) * (1 + Math.sin(tick * .85) * .012) * 100);
}
export type Candle = { open: number; high: number; low: number; close: number; volume: number };
export function candlesFor(symbol: string, period: string): Candle[] {
  const price = referencePrice(symbol);
  const seed = symbol.charCodeAt(0) + period.charCodeAt(0);
  let previous = price * .978;
  return Array.from({length:64},(_,i) => {
    const close = price * (.978 + i * .00036 + Math.sin(i * .74 + seed) * .0035 + Math.sin(i * .22) * .004);
    const open = previous;
    previous = close;
    return {open,close,high:Math.max(open,close)+price*(.0007+Math.abs(Math.sin(i*2))*.0017),low:Math.min(open,close)-price*(.0008+Math.abs(Math.cos(i))*.0011),volume:20+Math.abs(Math.sin(i*1.47))*65+(i>51?22:0)};
  });
}
export function amountToCents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return 0;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2,"0"));
  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}
