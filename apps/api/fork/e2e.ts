/**
 * The whole product, end to end, against a forked Base mainnet.
 *
 * Real: the Fastify app exactly as `main.ts` builds it, the PostgreSQL schema with its grants
 * and row-level security, the Chainlink feeds, Aerodrome's factory/quoter/router and their real
 * pool state, Coinbase's SpendPermissionManager and Smart Wallet factory, USDC, and the worker —
 * which runs in its own process against the same database, so nothing here fakes execution.
 *
 * Substituted: Privy (no token can be minted offline) and the seven B20 tokens, whose onchain
 * code is the single byte 0xef because they are native precompiles inside Base's execution
 * client rather than EVM contracts. Every B20 address holds a real ERC20 at its real address,
 * and every real pool was seeded with the balance it holds on mainnet.
 */
import { randomBytes } from "node:crypto";
import type { AuthenticatedUser } from "../../../packages/auth/src/index.js";
import { loadConfig } from "../../../packages/config/src/index.js";
import type { Hex } from "../../../packages/contracts/src/index.js";
import {
  connectDatabase,
  databaseReady,
  Repository,
  workerAvailable,
} from "../../../packages/database/src/index.js";
import { ASSETS, BaseReader } from "../../../packages/evm/src/index.js";
import { buildApp } from "../src/app.js";

export const ACCOUNT = "0x5642A685105000a36de7202d9174eCb8bb503fB5" as Hex;
const DID = `did:privy:fork${randomBytes(8).toString("hex")}`;

export async function boot() {
  const config = loadConfig();
  const connection = connectDatabase(config.databaseUrl);
  const repository = new Repository(connection.db);
  const chain = BaseReader.fromUrl(config.rpcUrl);
  const app = await buildApp({
    config,
    users: repository,
    wallets: { embedded: async () => null },
    // The only substitution. Everything downstream — the wallet check, the signature
    // verification, the row-level security context — runs on the real account below.
    auth: {
      async authenticate(header: string | undefined): Promise<AuthenticatedUser> {
        if (header !== "Bearer fork") throw new Error("unauthenticated");
        return { privyDid: DID, sessionId: "fork", wallets: [ACCOUNT.toLowerCase() as Hex] };
      },
    },
    databaseReady: () => databaseReady(connection.db),
    workerAvailable: () => workerAvailable(connection.db),
    chainReady: () => chain.ready(),
    trading: { repository, chain, assets: ASSETS },
  });
  return { app, close: () => Promise.all([app.close(), connection.close()]) };
}
