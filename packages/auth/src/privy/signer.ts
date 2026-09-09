import type { Hex } from "@mandate/contracts";
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import type { LocalAccount } from "viem";
import type { PrivyReader } from "./index.js";

/**
 * A user's Privy embedded wallet, as the server sees it.
 *
 * `delegated` is Privy's own word for "a signer this app registered may act for this wallet".
 * It is the single fact automatic buying turns on: the API checks it before an instance goes
 * auto, and the worker's signing simply fails without it.
 */
export type EmbeddedWallet = { id: string; address: Hex; delegated: boolean };

/** The embedded wallet at `address` among a user's linked accounts, if there is one. */
export async function embeddedWallet(
  reader: PrivyReader,
  privyDid: string,
  address: string,
  signerId?: string,
): Promise<EmbeddedWallet | null> {
  const user = await reader.user(privyDid);
  for (const account of user.linked_accounts) {
    if (
      account.type === "wallet" &&
      account.chain_type === "ethereum" &&
      account.connector_type === "embedded" &&
      account.id &&
      account.address?.toLowerCase() === address.toLowerCase()
    ) {
      const details = reader.wallet ? await reader.wallet(account.id) : null;
      const delegated = details
        ? details.additional_signers.some((signer) => !signerId || signer.signer_id === signerId)
        : account.delegated === true;
      return {
        id: account.id,
        address: account.address.toLowerCase() as Hex,
        delegated,
      };
    }
  }
  return null;
}

export interface PrivySignerOptions {
  appId: string;
  appSecret: string;
  /** The key quorum's P-256 private key, base64 PKCS8 — the worker's only secret. */
  authorizationKey: string;
}

/**
 * Signing from users' embedded wallets through Privy.
 *
 * The private key of the wallet never leaves Privy. What this process holds is the private half
 * of the app's signer; each request to sign is authorised with it and Privy checks the user
 * delegated that signer to the wallet. The result is a viem account, so the worker prepares,
 * simulates and broadcasts exactly as it would with a local key — against whichever RPC it is
 * pointed at, which is what makes the same code run on a fork.
 */
export class PrivySigner {
  private readonly client: PrivyClient;
  private readonly reader: PrivyReader;
  constructor(private readonly options: PrivySignerOptions) {
    this.client = new PrivyClient({
      appId: options.appId,
      appSecret: options.appSecret,
      timeout: 15000,
      maxRetries: 1,
    });
    this.reader = {
      verify: (token) => this.client.utils().auth().verifyAccessToken(token),
      user: (id) => this.client.users()._get(id),
      wallet: (id) => this.client.wallets().get(id),
    };
  }
  /** The embedded wallet a strategy signs with, or null when the user has none at that address. */
  wallet(privyDid: string, address: string) {
    return embeddedWallet(this.reader, privyDid, address);
  }
  /** A viem account for a delegated wallet. Signing fails at Privy if the delegation is gone. */
  account(wallet: EmbeddedWallet): LocalAccount {
    return createViemAccount(this.client, {
      walletId: wallet.id,
      address: wallet.address,
      authorizationContext: { authorization_private_keys: [this.options.authorizationKey] },
    }) as unknown as LocalAccount;
  }
}
