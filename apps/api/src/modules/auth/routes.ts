import type { Config } from "@mandate/config";
import { type Hex, Problem } from "@mandate/contracts";
import { CHAIN_ID } from "@mandate/evm";
import type { FastifyInstance } from "fastify";
import { type Automation, automationOf, type WalletReader } from "../automation/delegation.js";
import {
  type EligibilityReason,
  eligibilityReason,
  principal,
  type WalletState,
  walletSelection,
} from "./principal.js";

export interface AuthDependencies {
  /**
   * Optional so a caller without Privy still boots. `/v1/me` then reports nothing delegated,
   * and `/v1/me/wallets` answers 503 rather than inventing a delegation.
   */
  wallets?: WalletReader | undefined;
  workerAvailable?: (() => Promise<boolean>) | undefined;
}

export type MeResponse = {
  user: string;
  privy_did: string;
  wallets: readonly Hex[];
  wallet: Hex | null;
  wallet_state: WalletState;
  wallet_selection_required: boolean;
  jurisdiction: string;
  eligible: boolean;
  eligibility_reason: EligibilityReason | null;
  chain_id: number;
  automation: Automation;
  execution_available: boolean;
  server_time: string;
};

export type WalletItem = {
  address: Hex;
  /** A Privy embedded wallet. Only these can be delegated; an external wallet never can. */
  embedded: boolean;
  delegated: boolean;
};
export type WalletsResponse = {
  items: WalletItem[];
  chain_id: number;
  signer_id: string | null;
};

function definition(summary: string) {
  return { tags: ["auth"], summary, security: [{ privy: [] }] };
}

export async function registerAuth(app: FastifyInstance, config: Config, deps: AuthDependencies) {
  // Mirrors app.ts: a worker heartbeat lives in PostgreSQL, so this is one indexed read and it is
  // allowed to fail. A database outage must degrade this single boolean to false, not take down
  // the endpoint the whole frontend uses to decide whether the user is signed in at all.
  const available = async () => (await deps.workerAvailable?.().catch(() => false)) ?? false;

  app.get("/v1/me", { schema: definition("Current verified Privy identity") }, async (request) => {
    const user = principal(request);
    const header = request.headers["x-mandate-wallet"];
    // The header is the only client input this endpoint reads, and only as a lookup key against
    // the verified linked-wallet list. Query and body values are ignored entirely.
    const selection = walletSelection(user, typeof header === "string" ? header : undefined);
    // request.jurisdiction is set by the onRequest hook, which honours cf-ipcountry only from a
    // configured trusted proxy IP. Reading that header here would reintroduce the exact spoof
    // packages/auth guards against, so this module never touches it.
    const response: MeResponse = {
      user: user.user,
      privy_did: user.privyDid,
      wallets: user.wallets,
      wallet: selection.wallet,
      wallet_state: selection.state,
      wallet_selection_required: selection.state === "selection_required",
      jurisdiction: request.jurisdiction,
      eligible: request.eligible,
      eligibility_reason: eligibilityReason(request.jurisdiction, request.eligible),
      // The client refuses to sign on the wrong network rather than producing a signature bound
      // to a chain the API will not execute on.
      chain_id: CHAIN_ID,
      // One Privy read, and only when a wallet is actually selected: with two linked wallets and
      // no header there is nothing to ask about, and this endpoint is polled.
      automation: await automationOf(config, deps.wallets, user.privyDid, selection.wallet),
      execution_available: await available(),
      server_time: new Date().toISOString(),
    };
    // sessionId is deliberately absent. A 200 here proves the access token verified, not that the
    // Privy session is still live: local JWT verification cannot observe a logout or a revocation
    // (docs/architecture/decisions/0001-privy-auth.md). No field may imply otherwise, and this
    // module adds no login, logout or nonce route that would recreate a parallel session system.
    return response;
  });

  app.get(
    "/v1/me/wallets",
    {
      schema: definition("Delegation state of each linked wallet"),
      // Stricter than the global 120/min: every row is a Privy round trip, and /v1/me is the
      // endpoint that gets polled, not this one.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request) => {
      const user = principal(request);
      const wallets = deps.wallets;
      if (!wallets)
        throw Problem.unavailable("Wallet delegation checks are temporarily unavailable.");
      // One failed lookup degrades one row to "not delegated" rather than failing the list. The
      // error is dropped, not logged: Privy SDK errors carry request details.
      const items: WalletItem[] = await Promise.all(
        user.wallets.map(async (address) => {
          const embedded = await wallets.embedded(user.privyDid, address).catch(() => null);
          return { address, embedded: embedded !== null, delegated: embedded?.delegated === true };
        }),
      );
      const response: WalletsResponse = {
        items,
        chain_id: CHAIN_ID,
        signer_id: config.privySignerId ?? null,
      };
      return response;
    },
  );
}
