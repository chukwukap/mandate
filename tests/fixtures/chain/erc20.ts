import type { Hex } from "../../../packages/contracts/src/index.js";
import { units, whole } from "../../../packages/strategy/src/evaluation/money.js";
import { assetOf, B20_ASSETS, USDC, USDC_DECIMALS } from "./catalogue.js";

/**
 * ERC20 metadata and balances.
 *
 * The decimals field is the load-bearing one. Every B20 equity is 8 decimals, USDC is 6, and
 * nothing here is 18. A holding read at 18 decimals is 1e10 too small, and an order sized at
 * 18 decimals is 1e10 too large; `DECIMALS_TRAP` pins both directions so the mistake fails a
 * test instead of a transaction.
 */

export type TokenMetadata = {
  readonly address: Hex;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Raw integer supply. Fixture-chosen: plausible, never presented as measured. */
  readonly totalSupply: bigint;
};

/** Synthetic addresses. Deliberately unmistakable, so no fixture can be read as a real wallet. */
export const ACCOUNTS = {
  /** The strategy owner: signs the plan, grants the permission, receives the shares. */
  user: "0x1111111111111111111111111111111111111111",
  /** The worker's spender key. Pulls USDC, swaps, and must never hold a position. */
  spender: "0x2222222222222222222222222222222222222222",
  /** An unrelated account, for evidence that must NOT be credited to the user. */
  stranger: "0x3333333333333333333333333333333333333333",
} as const satisfies Record<string, Hex>;

export const TOKENS: readonly TokenMetadata[] = [
  {
    address: USDC,
    symbol: "USDC",
    name: "USD Coin",
    decimals: USDC_DECIMALS,
    totalSupply: 4_100_000_000_000_000n,
  },
  ...B20_ASSETS.map((asset) => ({
    address: asset.token,
    symbol: asset.symbol,
    name: `Coinbase ${asset.symbol.replace(/c$/, "")} Tokenized Equity`,
    decimals: asset.decimals,
    // 1,000,000 whole shares at 8 decimals. Non-zero on purpose: BaseReader.reference refuses
    // an asset whose totalSupply is 0, so a zero here would look like a broken token.
    totalSupply: 100_000_000_000_000n,
  })),
];

export function tokenOf(address: string): TokenMetadata {
  const token = TOKENS.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
  if (!token) throw new Error(`No token metadata for ${address}`);
  return token;
}

/**
 * The 8-vs-18 decimals trap, stated as data.
 *
 * One AAPLc share is 100_000_000 raw units. Read at 18 decimals the same integer is
 * 0.0000000001 shares — a position that looks empty, so every sell sizes against nothing.
 * Written at 18 decimals, an order for one share becomes 1e18 raw, which is ten billion
 * shares' worth of transfer.
 */
export const DECIMALS_TRAP = {
  shares: "1",
  correctDecimals: 8,
  wrongDecimals: 18,
  rawAtCorrect: 100_000_000n,
  rawAtWrong: 1_000_000_000_000_000_000n,
  factor: 10n ** 10n,
} as const;

/** Balances as raw integers, keyed `<lowercased holder>/<lowercased token>`. */
export type BalanceSheet = Map<string, bigint>;

export function balanceKey(holder: string, token: string): string {
  return `${holder.toLowerCase()}/${token.toLowerCase()}`;
}

/**
 * Build a balance sheet from decimal strings.
 *
 * Amounts are authored as decimals ("1500.25") and converted with the token's OWN decimals via
 * the production `units`, so a fixture cannot express a holding the chain could not represent
 * and cannot silently pick the wrong scale.
 */
export function balanceSheet(
  holdings: readonly { holder: Hex; token: Hex; amount: string }[],
): BalanceSheet {
  const sheet: BalanceSheet = new Map();
  for (const holding of holdings) {
    const token = tokenOf(holding.token);
    const key = balanceKey(holding.holder, holding.token);
    sheet.set(key, (sheet.get(key) ?? 0n) + units(holding.amount, token.decimals));
  }
  return sheet;
}

/** Raw balance, defaulting to zero — an address that has never held a token is not an error. */
export function balanceOf(sheet: BalanceSheet, holder: string, token: string): bigint {
  return sheet.get(balanceKey(holder, token)) ?? 0n;
}

/** Balance as a decimal string at the token's real scale. What the portfolio observer stores. */
export function balanceString(sheet: BalanceSheet, holder: string, token: string): string {
  return whole(balanceOf(sheet, holder, token), tokenOf(token).decimals);
}

/**
 * The default sheet: a funded user, an empty spender.
 *
 * The spender holding nothing is the invariant worth keeping. It pulls USDC and spends it in
 * the same order; a non-zero resting balance there means a previous order was funded and never
 * swapped or refunded, which is the state `RecoveryRequired` exists for.
 */
export const DEFAULT_BALANCES: BalanceSheet = balanceSheet([
  { holder: ACCOUNTS.user, token: USDC, amount: "2500" },
  { holder: ACCOUNTS.user, token: assetOf("AAPLc").token, amount: "5" },
  { holder: ACCOUNTS.user, token: assetOf("NVDAc").token, amount: "12.5" },
]);
