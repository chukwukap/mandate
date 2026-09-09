import type { EmbeddedWallet } from "@mandate/auth";
import type { Config } from "@mandate/config";
import { type Hex, Problem } from "@mandate/contracts";

/**
 * The one thing the API asks Privy about a wallet: is it an embedded wallet, and has the user
 * delegated it to the app's signer.
 *
 * A port rather than a direct `embeddedWallet(privyReader(...))` call so tests can answer it
 * without a network and so the worker's reading of the same fact (`PrivySigner.wallet`) and this
 * one cannot drift apart in shape.
 */
export interface WalletReader {
  embedded(privyDid: string, address: string): Promise<EmbeddedWallet | null>;
}

/** What `/v1/me` says about automatic buying for the wallet the request selected. */
export type Automation = {
  /** The API has a signer to delegate to. Without one nothing can be armed automatically. */
  supported: boolean;
  signer_id: string | null;
  /** The selected wallet, when it is an embedded wallet; null for any other linked address. */
  wallet: Hex | null;
  delegated: boolean;
};

/**
 * Delegation as `/v1/me` reports it. Never throws.
 *
 * `/v1/me` is the endpoint the frontend polls, and it decides whether the user is signed in at
 * all. A Privy blip must not turn every page into an error, so an unreadable delegation is
 * reported as `delegated: false` — the safe direction, since it only withholds an offer. The
 * paths that actually change an instance's mode use `delegation` below and fail loudly instead.
 */
export async function automationOf(
  config: Pick<Config, "privySignerId">,
  wallets: WalletReader | undefined,
  privyDid: string,
  address: Hex | null,
): Promise<Automation> {
  const signer = config.privySignerId ?? null;
  const base = { supported: Boolean(signer), signer_id: signer, wallet: null, delegated: false };
  if (!wallets || !address) return base;
  const embedded = await wallets.embedded(privyDid, address).catch(() => null);
  if (!embedded) return base;
  return { ...base, wallet: embedded.address, delegated: embedded.delegated };
}

/**
 * Delegation for a decision that puts money in motion, read live from Privy.
 *
 * Nothing here is cached. A user who removes the delegation in Privy has withdrawn consent, and
 * the next arm or automation toggle must see that rather than a value remembered from the last
 * poll. An unreachable Privy is a 503 on these paths: "not delegated" would be a guess, and a
 * guess in either direction is wrong — it either pauses a strategy the user did not pause or
 * arms one Privy would refuse to sign for.
 *
 * The upstream error is neither logged nor echoed. Privy SDK errors carry request details that
 * can include the app secret's authorization header.
 */
export async function delegation(
  wallets: WalletReader,
  privyDid: string,
  address: string,
): Promise<EmbeddedWallet | null> {
  try {
    return await wallets.embedded(privyDid, address);
  } catch {
    throw Problem.unavailable("Wallet delegation could not be read right now. Try again shortly.");
  }
}

export function automationRequired() {
  return new Problem(
    409,
    "automation-required",
    "Automatic buying is off",
    "Turn on automatic buying for this wallet first.",
  );
}

export function automationUnsupported() {
  return new Problem(
    409,
    "automation-unsupported",
    "Automatic buying unavailable",
    "This deployment has no signer for automatic buying. Strategies run as signals only.",
  );
}
