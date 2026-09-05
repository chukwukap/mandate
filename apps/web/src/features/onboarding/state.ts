import { stocks } from "../market/catalog";

export const onboardingKey = "mandate:onboarding:v1";
export type OnboardingPreferences = {
  version: 1;
  status: "completed" | "skipped";
  symbol: string;
  mode: "manual" | "auto";
};
export function parseOnboarding(value: string | null): OnboardingPreferences | null {
  if (!value) return null;
  try {
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== "object") return null;
    const row = data as Record<string, unknown>;
    if (
      row.version !== 1 ||
      !["completed", "skipped"].includes(String(row.status)) ||
      typeof row.symbol !== "string" ||
      !stocks.includes(row.symbol) ||
      !["manual", "auto"].includes(String(row.mode))
    )
      return null;
    return {
      version: 1,
      status: row.status as OnboardingPreferences["status"],
      symbol: row.symbol,
      mode: row.mode as OnboardingPreferences["mode"],
    };
  } catch {
    return null;
  }
}
