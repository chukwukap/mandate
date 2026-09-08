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
export type Draft = {
  artifact_id: string;
  name: string;
  render_text: string;
  confirm_message: string;
  expires_at: string;
};
