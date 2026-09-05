import { demoPrices } from "../market/preview";
export const usd = (cents: number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(cents / 100);
export function demoQuote(symbol: string, tick = 0) {
  const base = Number(demoPrices[symbol]);
  return Math.round(base * (1 + Math.sin(tick * .85) * .012) * 100);
}
export type Candle = { open: number; high: number; low: number; close: number; volume: number };
export function candlesFor(symbol: string, period: string): Candle[] {
  const price = Number(demoPrices[symbol] ?? "100");
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
