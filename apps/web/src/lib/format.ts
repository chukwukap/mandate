export function currency(value: string | number | undefined | null) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}
export const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
