import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type ApiDependencies, buildApp } from "../../apps/api/src/app.js";
import type { WalletReader } from "../../apps/api/src/modules/automation/index.js";
import type { ReceiptReader, Settlement } from "../../apps/api/src/modules/executions/index.js";
import type { AuthenticatedUser, Authenticator } from "../../packages/auth/src/index.js";
import { type Config, loadConfig } from "../../packages/config/src/index.js";
import type { Hex } from "../../packages/contracts/src/index.js";
import { Problem } from "../../packages/contracts/src/index.js";
import { type Database, Repository, schema } from "../../packages/database/src/index.js";
import { ASSETS } from "../../packages/evm/src/addresses/index.js";
import type { Compiler } from "../../packages/strategy/src/index.js";
import { units } from "../../packages/strategy/src/index.js";
import { B20_ASSETS, FakeChainClient, USDC } from "../fixtures/chain/index.js";

/**
 * The real Fastify application, booted by `buildApp`, over an in-process PostgreSQL.
 *
 * These suites pin the wire contract: the exact JSON every endpoint apps/web calls hands back,
 * the RFC7807 problem body, and the OpenAPI document. That is a different question from the one
 * `tests/integration/*` asks, and it wants a different substrate.
 *
 * An integration suite needs a real server because its properties — row level security under a
 * NOBYPASSRLS role, a second session blocking on `FOR UPDATE`, 40001 under contention — do not
 * exist anywhere else, and `tests/integration/database/harness.ts` correctly skips its whole
 * suite when no server is reachable. A contract suite must not skip. It is the guard rail that
 * fires when someone renames a response field, and a guard rail that quietly disappears on a
 * laptop with no `DATABASE_URL` is worse than none: the rename lands, every suite is green, and
 * the failure surfaces in the browser. So the database here is PGlite, migrated from the same
 * `packages/database/migrations` SQL the real server runs, and nothing in this directory opens a
 * socket to anything at all.
 *
 * What that costs is explicit: PGlite runs as the bootstrap superuser, so `FORCE ROW LEVEL
 * SECURITY` is inert here. Ownership is still enforced — every statement in `Repository` and
 * `ExecutionQueries` carries its own `user_id` predicate on top of the policy — but a
 * cross-tenant assertion in this directory would be proving the predicate, not the policy.
 * Tenant isolation is asserted where it is real, in tests/integration/database.
 *
 * Two ports are substituted and nothing else: Privy (no token can be minted offline) and the
 * chain (`tests/fixtures/chain`, which runs the production `assessRound`, `selectRoute` and
 * `permissionHash` over recorded Base mainnet data). The routes, the plugin pipeline, the error
 * handler and the swagger document are the production ones.
 */

/** Where the migrations live. The same files `bun run db:migrate` applies to a real server. */
const MIGRATIONS = new URL("../../packages/database/migrations/", import.meta.url);

/**
 * The catalogue the app is wired with: `packages/evm`'s own `ASSETS`, not a fixture subset.
 *
 * A contract test that served four of the seven listed equities would pin a market response the
 * deployed API does not produce, and the two entries that matter most here — an asset with a
 * live reference and no executable route — are among the three it would have dropped.
 */
export const CATALOGUE = ASSETS;

/**
 * One signed-in caller.
 *
 * `wallets` is a list because a Privy account genuinely can link several, and the API's
 * behaviour differs: with one linked wallet the header is optional, with two it is required and
 * omitting it is a 409. `wallet` is the first, which is what a single-wallet test means.
 */
export type TestIdentity = {
  readonly token: string;
  readonly privyDid: string;
  readonly wallet: Hex;
  readonly wallets: readonly Hex[];
};

/**
 * A caller nothing else in the process shares.
 *
 * The DID is random because `resolvePrivyUser` is insert-or-select on a UNIQUE column: two
 * suites that both asked for `did:privy:alice` would silently become one tenant. Wallets are
 * lowercase because `drafts.account` carries a `^0x[0-9a-f]{40}$` CHECK and `selectWallet`
 * matches the header against the stored form.
 */
export function newIdentity(options: { wallets?: number } = {}): TestIdentity {
  const suffix = randomBytes(12).toString("hex");
  const wallets = Array.from(
    { length: Math.max(1, options.wallets ?? 1) },
    () => `0x${randomBytes(20).toString("hex")}` as Hex,
  );
  const first = wallets[0] as Hex;
  return {
    token: `token-${suffix}`,
    privyDid: `did:privy:ct${suffix}`,
    wallet: first,
    wallets,
  };
}

/** The token that makes the authenticator report an outage (503) rather than a rejection (401). */
export const PROVIDER_DOWN_TOKEN = "provider-down";

/**
 * A stand-in for `PrivyAuthenticator` with the same three-way contract.
 *
 * It verifies nothing cryptographically — a Privy bearer token cannot be minted offline, and
 * faking the verification would only test the fake. What it reproduces exactly is which failure
 * is 401 and which is 503, because the problem body of both is part of the contract.
 */
export class TestAuthenticator implements Authenticator {
  constructor(private readonly identities: readonly TestIdentity[]) {}

  async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const match = authorization?.match(/^Bearer (\S+)$/i);
    if (!match?.[1]) throw Problem.unauthenticated();
    if (match[1] === PROVIDER_DOWN_TOKEN)
      throw Problem.unavailable("Authentication verification is temporarily unavailable.");
    const found = this.identities.find((identity) => identity.token === match[1]);
    if (!found) throw Problem.unauthenticated();
    return { privyDid: found.privyDid, sessionId: "session", wallets: [...found.wallets] };
  }
}

/**
 * The fixture chain plus a registry of messages a test has "signed".
 *
 * Personal-signature verification is real ECDSA recovery for an EOA and an `eth_call` for a
 * contract wallet; neither is reachable from here, and viem cannot be imported at this level.
 * So `sign` records the exact string a route will later be asked to verify and `verifyMessage`
 * accepts that string and no other — the property under test is unchanged, since a signature
 * over anything but the stored `confirm_message` is still refused.
 */
export class TestChain extends FakeChainClient {
  private readonly signed = new Map<string, string>();
  private issued = 0;

  constructor() {
    super({ assets: B20_ASSETS });
  }

  private static key(address: string, message: string) {
    return `${address.toLowerCase()}|${message}`;
  }

  /** Records a signature for one wallet over one exact message and returns its bytes. */
  sign(address: string, message: string): Hex {
    this.issued += 1;
    const signature = `0x${this.issued.toString(16).padStart(4, "0")}${"ab".repeat(63)}` as Hex;
    this.signed.set(TestChain.key(address, message), signature.toLowerCase());
    return signature;
  }

  override async verifyMessage(address: Hex, message: string, signature: Hex): Promise<boolean> {
    return this.signed.get(TestChain.key(address, message)) === signature.toLowerCase();
  }
}

/** The worker spender the API advertises. Public, and never a key. */
export const APP_ORIGIN = "http://localhost:3000";

export function contractConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    APP_ORIGIN,
    // Never opened: the database handle is injected and every chain read is the fixture client.
    DATABASE_URL: "postgres://contract:contract@127.0.0.1:9/contract",
    BASE_RPC_URL: "http://127.0.0.1:9",
    PRIVY_APP_ID: "contract-app",
    PRIVY_APP_SECRET: "contract-secret",
    ELIGIBLE_COUNTRIES: "GB,NG",
    TRUSTED_PROXY_IPS: "127.0.0.1",
    DEV_COUNTRY: "GB",
    LOG_LEVEL: "silent",
    API_DOCS: "1",
    ...overrides,
  });
}

export type ContractApi = {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly db: Database;
  readonly repo: Repository;
  readonly chain: TestChain;
  readonly config: Config;
  /** Raw SQL for the tables whose production writer is the worker, not this API. */
  sql(text: string, values?: readonly unknown[]): Promise<void>;
  close(): Promise<void>;
};

export type StartOptions = {
  wallets?: WalletReader;
  identities?: readonly TestIdentity[];
  receipts?: ReceiptReader;
  config?: Record<string, string>;
  /** Both default to available. Pass false to pin the degraded body of /ready and /v1/me. */
  databaseReady?: boolean;
  workerAvailable?: boolean;
  /**
   * The natural-language strategy compiler. Absent by default, which is the deployment without
   * an Anthropic key, and is why POST /v1/strategies/draft answers 503 to a prompt.
   */
  compiler?: Compiler | undefined;
};

/**
 * Boots one application. Each suite owns its own — a shared instance would let one file's
 * `MarketSnapshots` TTL cache decide another file's assertions.
 */
export async function startContractApi(options: StartOptions = {}): Promise<ContractApi> {
  const pglite = new PGlite();
  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  // Applied in filename order, exactly as the migrator does. 0004 adds `recovery_required` to
  // the execution CHECK and 0005 makes `transactions` append-only, and both are load-bearing
  // for what these suites seed.
  for (const file of files) await pglite.exec(await readFile(new URL(file, MIGRATIONS), "utf8"));
  const db = drizzle(pglite, { schema }) as unknown as Database;
  const repo = new Repository(db);
  const chain = new TestChain();
  const config = contractConfig(options.config ?? {});
  const deps: ApiDependencies = {
    config,
    auth: new TestAuthenticator(options.identities ?? []),
    users: repo,
    wallets: options.wallets ?? { embedded: async () => null },
    databaseReady: async () => options.databaseReady ?? true,
    workerAvailable: async () => options.workerAvailable ?? true,
    chainReady: () => chain.ready(),
    trading: {
      repository: repo,
      chain,
      assets: CATALOGUE,
      ...(options.compiler ? { compiler: options.compiler } : {}),
    },
    ...(options.receipts ? { executions: { receipts: options.receipts } } : {}),
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    db,
    repo,
    chain,
    config,
    sql: async (text, values) => {
      await pglite.query(text, values ? [...values] : undefined);
    },
    close: async () => {
      await app.close();
      await pglite.close();
    },
  };
}

/**
 * A distinct source address per request.
 *
 * The rate limiter keys on `request.ip` at 120/min, with tighter limits on the draft route and
 * the execution detail. A suite that looked like one client would start asserting 429s halfway
 * through instead of the contract it came for, and these are genuinely different callers.
 */
let peer = 0;
export function nextPeer(): string {
  peer += 1;
  return `10.${(peer >> 16) & 255}.${(peer >> 8) & 255}.${peer & 255}`;
}

export type InjectOptions = {
  method?: "GET" | "POST" | "OPTIONS" | "PUT" | "DELETE";
  url: string;
  token?: string | undefined;
  wallet?: string | undefined;
  /** A JSON body, or a raw string when the point of the test is a malformed one. */
  payload?: string | object | undefined;
  headers?: Record<string, string>;
  remoteAddress?: string;
};

/** One request through the whole pipeline: context, origin guard, jurisdiction, auth, route. */
export function call(api: ContractApi, options: InjectOptions) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.wallet) headers["x-mandate-wallet"] = options.wallet;
  return api.app.inject({
    method: options.method ?? "GET",
    url: options.url,
    headers,
    remoteAddress: options.remoteAddress ?? nextPeer(),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

export type Body = Record<string, unknown>;

/** Caps far enough out to satisfy the draft route's one-minute expiry floor. */
export function draftCaps(overrides: Record<string, unknown> = {}) {
  return {
    lifetime: "100",
    per_order: "10",
    per_period: "20",
    period_secs: 86_400,
    max_orders_per_period: 2,
    cooldown_secs: 60,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    slippage_bps: 50,
    ...overrides,
  };
}

/** One rule: buy 10 USDC of AAPLc whenever the oracle prints under 300. */
export const BUY_PLAN = {
  params: [],
  nodes: [
    {
      id: "cheap",
      op: "lt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "300" },
      ],
    },
  ],
  machines: [
    {
      id: "buy",
      scope: "portfolio",
      initial: "watch",
      states: [
        {
          id: "watch",
          transitions: [
            {
              when: "cheap",
              fires: "on_edge",
              to: "watch",
              actions: [
                { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export type Committed = {
  readonly artifactId: string;
  readonly strategy: string;
  readonly instance: string;
  readonly confirmMessage: string;
};

/**
 * The whole authoring flow: draft, sign the exact stored review, submit.
 *
 * Deliberately not a row insert. The instance every other suite reads is only trustworthy as a
 * contract fixture if the API itself produced it from a signature it accepted.
 */
export async function commitStrategy(
  api: ContractApi,
  identity: TestIdentity,
  options: { mode?: "manual" | "auto"; plan?: unknown; caps?: Record<string, unknown> } = {},
): Promise<Committed> {
  const draft = await call(api, {
    method: "POST",
    url: "/v1/strategies/draft",
    token: identity.token,
    // Always explicit. With two linked wallets the header is mandatory, and letting it default
    // would make this helper work for one kind of identity and 409 for the other.
    wallet: identity.wallet,
    payload: {
      name: "AAPL entry",
      plan: options.plan ?? BUY_PLAN,
      caps: draftCaps(options.caps ?? {}),
      assets: ["AAPLc"],
      mode: options.mode ?? "manual",
    },
  });
  if (draft.statusCode !== 201)
    throw new Error(`draft failed: ${draft.statusCode} ${draft.body.slice(0, 300)}`);
  const body = draft.json<{ artifact_id: string; confirm_message: string }>();
  const signature = api.chain.sign(identity.wallet, body.confirm_message);
  const created = await call(api, {
    method: "POST",
    url: "/v1/strategies",
    token: identity.token,
    wallet: identity.wallet,
    payload: { artifact_id: body.artifact_id, signature },
  });
  if (created.statusCode !== 201)
    throw new Error(`commit failed: ${created.statusCode} ${created.body.slice(0, 300)}`);
  const created_body = created.json<{ instance: string; strategy: string }>();
  return {
    artifactId: body.artifact_id,
    strategy: created_body.strategy,
    instance: created_body.instance,
    confirmMessage: body.confirm_message,
  };
}

/**
 * An order, written the way `Admission.run` writes one.
 *
 * Raw SQL because the production writer is the worker, which is not in this process. Amounts
 * are integer strings in the token's own smallest unit — `executions.amount_in` carries a CHECK
 * for exactly that shape, and USDC is 6 decimals while every B20 equity is 8.
 */
export async function seedExecution(
  api: ContractApi,
  user: string,
  instance: string,
  options: {
    status?: string;
    stage?: string;
    amountUsdc?: string;
    reason?: string | null;
    txHash?: string | null;
    createdAt?: Date;
  } = {},
): Promise<{ id: string; amountRaw: string }> {
  const amount = options.amountUsdc ?? "10";
  const id = randomUUID();
  const createdAt = options.createdAt ?? new Date();
  const amountRaw = units(amount, 6).toString();
  const aapl = B20_ASSETS[0];
  if (!aapl) throw new Error("fixture catalogue is empty");
  await api.sql(
    `insert into mandate_v2.executions
       (id, user_id, instance_id, status, token_in, token_out, amount_in, intent, stage,
        reason, tx_hash, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      id,
      user,
      instance,
      options.status ?? "confirmed",
      USDC,
      aapl.token,
      amountRaw,
      JSON.stringify({ asset: 0, side: "buy", amount, fireKey: "buy:watch:cheap" }),
      options.stage ?? "done",
      options.reason ?? null,
      options.txHash ?? null,
      createdAt,
    ],
  );
  return { id, amountRaw };
}

/** A journal row. Append-only from 0005 onward, so nothing here is ever deleted again. */
export async function seedTransaction(
  api: ContractApi,
  user: string,
  execution: string,
  options: {
    leg?: string;
    status?: string;
    hash?: string;
    evidence?: { amount: string; recipient: string; token: string; from?: string } | null;
    nonce?: number;
  } = {},
): Promise<{ hash: string }> {
  const hash = options.hash ?? `0x${randomBytes(32).toString("hex")}`;
  await api.sql(
    `insert into mandate_v2.transactions
       (id, user_id, execution_id, leg, signer, nonce, raw_transaction, hash, status, evidence,
        created_at, confirmed_at)
     values ($1, $2, $3, $4,
       (select d.account from mandate_v2.executions e
        join mandate_v2.instances i on i.id = e.instance_id
        join mandate_v2.drafts d on d.id = i.draft_id where e.id = $3),
       $5, $6, $7, $8, $9, now(), $10)`,
    [
      randomUUID(),
      user,
      execution,
      options.leg ?? "swap",
      options.nonce ?? Math.floor(Math.random() * 1_000_000),
      "0x02f8",
      hash,
      options.status ?? "confirmed",
      options.evidence === null ? null : JSON.stringify(options.evidence ?? null),
      options.status === "signed" ? null : new Date(),
    ],
  );
  return { hash };
}

/** An evaluation row, which is what pairs a decision to an order in the detail response. */
export async function seedEvaluation(
  api: ContractApi,
  user: string,
  instance: string,
  options: {
    at?: Date;
    outcome?: string;
    admitted?: number;
    refused?: string | null;
    inputs?: Record<string, string>;
  } = {},
): Promise<void> {
  await api.sql(
    `insert into mandate_v2.evaluations
       (id, user_id, instance_id, at, outcome, admitted, refused, inputs, notifications)
     values ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb)`,
    [
      randomUUID(),
      user,
      instance,
      options.at ?? new Date(),
      options.outcome ?? "evaluated",
      options.admitted ?? 0,
      options.refused ?? null,
      JSON.stringify(options.inputs ?? { "oracle:AAPLc": "320.08" }),
    ],
  );
}

/**
 * A receipt reader that answers from a fixed table.
 *
 * Wired only where the settlement half of the execution detail is the thing being pinned;
 * everywhere else the reader is absent, which is the shipped default and produces
 * `settlement: null` with an unverified fill.
 */
export class StubReceipts implements ReceiptReader {
  constructor(private readonly settlements: ReadonlyMap<string, Settlement | null>) {}
  async settlement(request: { hash: Hex }): Promise<Settlement | null> {
    return this.settlements.get(request.hash.toLowerCase()) ?? null;
  }
}
