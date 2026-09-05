import type { AuthenticatedUser } from "@mandate/auth";
import { type Hex, Problem } from "@mandate/contracts";
import type { FastifyRequest } from "fastify";

/** Privy's verified claims plus the local database user the onRequest hook resolved from the DID. */
export type Principal = AuthenticatedUser & { user: string };

/**
 * The onRequest hook in app.ts authenticates every `/v1/*` path except `/v1/market`, so a
 * populated principal is the normal case. It stays null when the hook never ran for this path,
 * which would otherwise publish identity to an unauthenticated caller: fail closed instead.
 */
export function principal(request: FastifyRequest): Principal {
  if (!request.principal) throw Problem.unauthenticated();
  return request.principal;
}

export type WalletState = "resolved" | "selection_required" | "none_linked" | "not_linked";
export type WalletSelection = { wallet: Hex | null; state: WalletState };

/**
 * Non-throwing mirror of `selectWallet` from @mandate/auth.
 *
 * Trading routes want the 403/409 that `selectWallet` throws; `/v1/me` is the endpoint that has
 * to *describe* the situation so the client can render a wallet picker instead of retrying a
 * request that cannot succeed. Both read the same input — the verified Privy linked-wallet list
 * — and `apps/api/test/auth.test.ts` pins them together case by case so they cannot drift.
 *
 * The requested address is only ever used as a lookup key. An address that is not in the verified
 * list resolves to null, never to itself: echoing it back would let a caller plant an address the
 * frontend then sends on every subsequent trading call, and would look like provenance to any
 * future reader of this response.
 */
export function walletSelection(
  user: Pick<Principal, "wallets">,
  requested?: string | undefined,
): WalletSelection {
  if (requested) {
    // Privy addresses are stored lowercased; the header commonly arrives EIP-55 checksummed.
    const wallet = user.wallets.find((address) => address === requested.toLowerCase());
    return wallet ? { wallet, state: "resolved" } : { wallet: null, state: "not_linked" };
  }
  const only = user.wallets.length === 1 ? user.wallets[0] : undefined;
  if (only) return { wallet: only, state: "resolved" };
  // selectWallet raises the same 409 for zero and for many, but the two need different UI:
  // one asks the user to link a wallet, the other to choose between wallets they already have.
  return {
    wallet: null,
    state: user.wallets.length === 0 ? "none_linked" : "selection_required",
  };
}

export type EligibilityReason = "region_unknown" | "region_restricted" | "region_unsupported";

/**
 * Why `eligible` is false, as a class rather than a policy dump.
 *
 * Returning the configured allowlist would turn a per-user answer into an enumerable map of where
 * Mandate operates. `region_unknown` is the honest answer when no trusted proxy stamped a country
 * (`jurisdiction()` returns "XX"): the user is not barred, we simply cannot place them, and the
 * client should say so rather than accusing them of being in a restricted market.
 */
export function eligibilityReason(country: string, isEligible: boolean): EligibilityReason | null {
  if (isEligible) return null;
  if (country === "XX") return "region_unknown";
  if (country === "US") return "region_restricted";
  return "region_unsupported";
}
