import type { Asset } from "@mandate/contracts";
export type Strategy = {
  id: string;
  name: string;
  status: "armed" | "paused" | "halted" | "ended";
  mode: "manual" | "auto";
  requested_mode?: "manual" | "auto";
  spent: string;
  lifetime: string;
  orders: number;
  created_at: string;
  last_tick_at: string | null;
  halt_reason?: string | null;
  execution_available: boolean;
  account?: string;
  render_text?: string;
  envelope?: { assets: Asset[]; caps: { expires_at: string } };
  /** Symbols this strategy watches, on every list row. The full envelope is detail-only. */
  assets?: string[];
};
/**
 * `POST /v1/strategies`. `needs_automation` is true for a strategy asked to buy automatically
 * whose wallet is not yet delegated — it will arm as signal-only until automatic buying is on.
 */
export type CreatedStrategy = Strategy & { needs_automation: boolean };
export type Draft = {
  artifact_id: string;
  name: string;
  /** The bytes the signature covers. `confirm_message` wraps this with header lines. */
  render_text: string;
  confirm_message: string;
  expires_at: string;
  /**
   * The structured review the API has always returned and the web has never read.
   *
   * Produced by the same deterministic renderer whose sha256 folds into `artifact_id`, so a
   * review built from these sections cannot disagree with what was validated and signed.
   * Optional because an older API may not send it, in which case the exact text still shows.
   */
  card?: {
    authority: string[];
    parameters: string[];
    rules: string[];
    cautions: string[];
  };
};
