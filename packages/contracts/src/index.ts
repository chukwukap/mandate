import { z } from "zod";

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const signatureSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .max(32770);
export const idSchema = z.uuid();
export const modeSchema = z.enum(["manual", "auto"]);
export const statusSchema = z.enum(["armed", "paused", "halted", "ended"]);
export const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.iso.datetime({ offset: true }).optional(),
    before_id: z.uuid().optional(),
  })
  .refine((page) => !page.before_id || Boolean(page.before), "before_id requires before");
export type Mode = z.infer<typeof modeSchema>;
export type InstanceStatus = z.infer<typeof statusSchema>;
export type Hex = `0x${string}`;
export type Asset = { symbol: string; token: Hex; feed: Hex; decimals: number };
export type MarketFeed = { uri: string; value: string | null; updated_at: number; stale: boolean };
/** One token balance, in whole units. Pricing is deliberately not this type's business. */
export type Position = { symbol: string; token: Hex; decimals: number; quantity: string };
/**
 * What an address actually holds on chain, read directly from the token contracts.
 *
 * Quantities only — no prices and no valuation. Holdings and prices come from different sources
 * with different failure modes and different staleness, and a type that fused them would have to
 * pick one `stale` flag for both. Callers join this against a market snapshot, so the number a
 * portfolio shows is the same number the market page shows.
 */
export type WalletBalances = { at: number; cash: string; positions: Position[] };
export type Quote = {
  token_in: Hex;
  token_out: Hex;
  amount_in: string;
  amount_out: string;
  min_out: string;
  tick_spacing: number;
  expires_at: string;
  reference: string;
};
export type PermissionPayload = {
  account: Hex;
  spender: Hex;
  token: Hex;
  allowance: string;
  period: number;
  start: number;
  end: number;
  salt: string;
  extraData: Hex;
};
export type Call = { to: Hex; data: Hex; value: string; chain_id: number };
export type PermissionCheck = { approved: boolean; revoked: boolean };
export type Identity = {
  user: string;
  wallet: Hex;
  walletKind: "eoa" | "base_account" | "contract";
  privyDid: string;
  sessionId: string;
};
export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  request_id?: string;
};

export class Problem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    public readonly detail: string,
  ) {
    super(detail);
  }
  static notFound() {
    return new Problem(404, "not-found", "Not found", "That resource is unavailable.");
  }
  static unauthenticated() {
    return new Problem(401, "unauthenticated", "Sign in required", "Sign in to continue.");
  }
  static unavailable(detail: string) {
    return new Problem(503, "unavailable", "Temporarily unavailable", detail);
  }
}

/**
 * Reading token balances for an address.
 *
 * Kept out of `ChainReader` on purpose. Every fake in the test suites implements ChainReader, so
 * adding a method there is a breaking change to a dozen files for the benefit of the two callers
 * that need balances. A narrow interface lets those two ask for exactly the capability they use.
 */
export interface BalanceReader {
  balances(address: Hex, assets: readonly Asset[]): Promise<WalletBalances>;
}

// Applications depend on capabilities; test implementations never acquire signing keys.
export interface ChainReader {
  verifyMessage(address: Hex, message: string, signature: Hex): Promise<boolean>;
  verifyPermission(payload: PermissionPayload, signature: Hex): Promise<boolean>;
  walletKind(address: Hex): Promise<Identity["walletKind"]>;
  permissionStatus(payload: PermissionPayload): Promise<PermissionCheck>;
  market(): Promise<MarketFeed[]>;
  quote(asset: Asset, side: "buy" | "sell", amount: string, slippageBps: number): Promise<Quote>;
  ready(): Promise<boolean>;
}

export * from "./types/index.js";
