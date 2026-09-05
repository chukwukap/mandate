import { type Hex, Problem } from "@mandate/contracts";
import type { AuthenticatedUser } from "../privy/index.js";

export function selectWallet(user: AuthenticatedUser, requested?: string): Hex {
  if (requested) {
    const wallet = user.wallets.find((address) => address === requested.toLowerCase());
    if (!wallet)
      throw new Problem(
        403,
        "wallet-not-linked",
        "Wallet not linked",
        "Link this Ethereum wallet to your Privy account first.",
      );
    return wallet;
  }
  if (user.wallets.length === 1 && user.wallets[0]) return user.wallets[0];
  throw new Problem(
    409,
    "wallet-selection-required",
    "Choose a wallet",
    "Select a linked Ethereum wallet using the X-Mandate-Wallet header.",
  );
}
