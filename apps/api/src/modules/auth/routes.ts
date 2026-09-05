import type { Config } from "@mandate/config";
import { type ChainReader, type Hex, Problem } from "@mandate/contracts";
import { CHAIN_ID } from "@mandate/evm";
import type { FastifyInstance } from "fastify";
import { WalletCapabilities, type WalletCapability } from "./capabilities.js";
import {
  type EligibilityReason,
  eligibilityReason,
  principal,
  type WalletState,
  walletSelection,
} from "./principal.js";

export interface AuthDependencies {
  /**
   * Optional so a caller without a chain reader still boots. `/v1/me` never touches it; only
   * `/v1/me/wallets` does, and it answers 503 rather than inventing a capability.
   */
  chain?: ChainReader | undefined;
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
  automation_supported: boolean;
  execution_available: boolean;
  server_time: string;
};
export type WalletsResponse = {
  items: WalletCapability[];
  chain_id: number;
  automation_supported: boolean;
  notice: string;
};

const CAPABILITY_NOTICE =
  "Wallet capability is a cached onchain observation used to decide what to offer. Automatic execution is authorized only by a spending permission that is re-checked against the chain when it is prepared.";

function definition(summary: string) {
  return { tags: ["auth"], summary, security: [{ privy: [] }] };
}

export async function registerAuth(app: FastifyInstance, config: Config, deps: AuthDependencies) {
  const capabilities: WalletCapabilities | undefined = deps.chain
    ? new WalletCapabilities(deps.chain)
    : undefined;
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
      automation_supported: Boolean(config.spenderAddress),
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
      schema: definition("Automation capability of each linked wallet"),
      // Stricter than the global 120/min: every miss here is a paced RPC round trip, and /v1/me
      // is the endpoint that gets polled, not this one.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request) => {
      const user = principal(request);
      if (!capabilities)
        throw Problem.unavailable("Wallet capability checks are temporarily unavailable.");
      const response: WalletsResponse = {
        items: await capabilities.kinds(user.wallets),
        chain_id: CHAIN_ID,
        automation_supported: Boolean(config.spenderAddress),
        notice: CAPABILITY_NOTICE,
      };
      return response;
    },
  );
}
