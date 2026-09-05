import { type ApiDependencies, buildApp } from "../../../apps/api/src/app.js";
import type { ReceiptReader } from "../../../apps/api/src/modules/executions/index.js";
import type { AuthenticatedUser, Authenticator } from "../../../packages/auth/src/index.js";
import type { Config } from "../../../packages/config/src/index.js";
import { loadConfig } from "../../../packages/config/src/index.js";
import type {
  Asset,
  ChainReader,
  Hex,
  Identity,
  MarketFeed,
  PermissionCheck,
  PermissionPayload,
  Quote,
} from "../../../packages/contracts/src/index.js";
import { Problem } from "../../../packages/contracts/src/index.js";
import { databaseReady, workerAvailable } from "../../../packages/database/src/index.js";
import { B20_ASSETS, FakeChainClient, plainAsset } from "../../fixtures/chain/index.js";
import { DATABASE_URL, openPostgres, type Postgres } from "../database/harness.js";

/**
 * The real Fastify application, booted the way `main.ts` boots it, against a real PostgreSQL.
 *
 * `apps/api/test` builds each module onto a bare Fastify instance with a hand-rolled error
 * handler, because those suites own one module at a time and another process owns `app.ts`.
 * That leaves a real gap: nothing there proves the plugins are registered in the order the
 * security depends on, that a skipped `skip-override` marker has not made every `/v1` route
 * anonymous, that helmet and the rate limiter are attached, or that a `Problem` thrown deep in a
 * repository comes back as RFC7807 with a correlation id. All of that only exists in `app.ts`,
 * and all of it is what this harness exercises.
 *
 * Two ports are substituted and nothing else: Privy (there is no network here, and a real token
 * cannot be minted) and the chain (the recorded fixture client in `tests/fixtures/chain`). The
 * database, the routes, the plugin pipeline and the error handler are the production ones.
 */

/** One signed-in caller. `token` is what a test puts in the Authorization header. */
export type TestIdentity = {
  readonly token: string;
  readonly privyDid: string;
  readonly wallet: Hex;
};

/**
 * The token that makes the authenticator report an outage instead of a rejection.
 *
 * `PrivyAuthenticator` draws this distinction deliberately — 401 for a bad token, 503 when Privy
 * is unreachable — and it matters: answering 401 during a provider blip tells every signed-in
 * user their session was revoked, and they all re-authenticate against the provider that is
 * already down. The plugin has no try/catch precisely so that distinction survives, which is
 * only assertable with an authenticator that can produce both.
 */
export const PROVIDER_DOWN_TOKEN = "provider-down";

/**
 * A stand-in for `PrivyAuthenticator` with the same three-way contract.
 *
 * It verifies nothing cryptographically: a bearer token minted by Privy cannot be produced
 * offline, and faking the verification would only test the fake. What it does reproduce exactly
 * is which failures are 401 and which are 503, because that is what the plugin is wired to.
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
    return { privyDid: found.privyDid, sessionId: "session", wallets: [found.wallet] };
  }
}

/**
 * The fixture chain plus a registry of messages a test has "signed".
 *
 * Personal-signature verification is an `eth_call` against a contract wallet in production and
 * real ECDSA recovery for an EOA; neither is available here, and `viem` cannot even be imported
 * from `tests/` (no `node_modules` at this level). So `sign` records the exact string a route
 * will later be asked to verify, and `verifyMessage` accepts that string and no other. The
 * property under test is unchanged: a signature over anything but the stored `confirm_message`,
 * or by any wallet but the one the draft records, is refused.
 *
 * Everything else — permission digests, onchain approval state, quotes, feeds — is the fixture
 * client's, which runs the production `permissionHash`, `assessRound` and `selectRoute`.
 */
export class TestChain implements ChainReader {
  readonly fake: FakeChainClient;
  private readonly signed = new Map<string, string>();
  private issued = 0;

  constructor(options: { assets?: readonly Asset[] } = {}) {
    this.fake = new FakeChainClient({
      // The four assets the shipped catalogue routes, so the market snapshot and the catalogue
      // describe the same universe.
      assets: options.assets
        ? B20_ASSETS.filter((asset) =>
            options.assets?.some((wanted) => wanted.symbol === asset.symbol),
          )
        : B20_ASSETS.filter((asset) => asset.shipped),
    });
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

  async verifyMessage(address: Hex, message: string, signature: Hex): Promise<boolean> {
    return this.signed.get(TestChain.key(address, message)) === signature.toLowerCase();
  }

  verifyPermission(payload: PermissionPayload, signature: Hex): Promise<boolean> {
    return this.fake.verifyPermission(payload, signature);
  }
  walletKind(address: Hex): Promise<Identity["walletKind"]> {
    return this.fake.walletKind(address);
  }
  permissionStatus(payload: PermissionPayload): Promise<PermissionCheck> {
    return this.fake.permissionStatus(payload);
  }
  market(): Promise<MarketFeed[]> {
    return this.fake.market();
  }
  quote(asset: Asset, side: "buy" | "sell", amount: string, slippageBps: number): Promise<Quote> {
    return this.fake.quote(asset, side, amount, slippageBps);
  }
  ready(): Promise<boolean> {
    return this.fake.ready();
  }
}

/** The worker spender the API advertises. Public, and never a key. */
export const SPENDER_ADDRESS = "0x2222222222222222222222222222222222222222";

/** The single proxy IP allowed to assert `cf-ipcountry`. Everything else lands on DEV_COUNTRY. */
export const TRUSTED_PROXY_IP = "127.0.0.1";

export const APP_ORIGIN = "http://localhost:3000";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    APP_ORIGIN,
    DATABASE_URL,
    // Never contacted: `chainReady` and every chain read is the injected fixture client. It is
    // an unroutable address rather than a plausible one so a leak would fail loudly.
    BASE_RPC_URL: "http://127.0.0.1:9",
    SPENDER_ADDRESS,
    PRIVY_APP_ID: "integration-app",
    PRIVY_APP_SECRET: "integration-secret",
    ELIGIBLE_COUNTRIES: "GB,NG",
    TRUSTED_PROXY_IPS: TRUSTED_PROXY_IP,
    DEV_COUNTRY: "GB",
    LOG_LEVEL: "silent",
    API_DOCS: "1",
    ...overrides,
  });
}

export type ApiHarness = {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly pg: Postgres;
  readonly chain: TestChain;
  readonly config: Config;
  close(): Promise<void>;
};

export async function startApi(
  options: {
    identities?: readonly TestIdentity[];
    receipts?: ReceiptReader;
    config?: Record<string, string>;
  } = {},
): Promise<ApiHarness> {
  const pg = openPostgres();
  const chain = new TestChain();
  const config = testConfig(options.config ?? {});
  const deps: ApiDependencies = {
    config,
    auth: new TestAuthenticator(options.identities ?? []),
    users: pg.repo,
    databaseReady: () => databaseReady(pg.db),
    workerAvailable: () => workerAvailable(pg.db),
    chainReady: () => chain.ready(),
    trading: {
      repository: pg.repo,
      chain,
      // The catalogue the routes offer. Deliberately the shipped four, matching production.
      assets: B20_ASSETS.filter((asset) => asset.shipped).map(plainAsset),
    },
    ...(options.receipts ? { executions: { receipts: options.receipts } } : {}),
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    pg,
    chain,
    config,
    close: async () => {
      await app.close();
      await pg.close();
    },
  };
}

/**
 * A distinct source address per request.
 *
 * The rate limiter keys on `request.ip` and the app allows 120 requests a minute per IP, with
 * 10/min on the draft route. A suite that made every call look like one client would start
 * asserting 429s half way through instead of the behaviour it came for. Rotating the peer is
 * also honest: these are different callers.
 */
let peer = 0;
export function nextPeer(): string {
  peer += 1;
  return `10.${(peer >> 16) & 255}.${(peer >> 8) & 255}.${peer & 255}`;
}

export type InjectOptions = {
  method?: "GET" | "POST" | "OPTIONS";
  url: string;
  token?: string | undefined;
  wallet?: string | undefined;
  payload?: unknown;
  headers?: Record<string, string>;
  /** Overrides the rotating source address. Use `TRUSTED_PROXY_IP` to assert a jurisdiction. */
  remoteAddress?: string;
};

/** One request through the whole pipeline: origin guard, jurisdiction, authentication, route. */
export function call(harness: ApiHarness, options: InjectOptions) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.wallet) headers["x-mandate-wallet"] = options.wallet;
  return harness.app.inject({
    method: options.method ?? "GET",
    url: options.url,
    headers,
    remoteAddress: options.remoteAddress ?? nextPeer(),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** The RFC7807 body every failure in this API is supposed to have. */
export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  request_id: string;
};

export type Body = Record<string, unknown>;

/** Caps far enough out to satisfy the draft route's one-minute floor. */
export function draftCaps(overrides: Record<string, unknown> = {}) {
  return {
    lifetime: "100",
    per_order: "10",
    per_period: "20",
    period_secs: 86400,
    max_orders_per_period: 2,
    cooldown_secs: 60,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    slippage_bps: 50,
    ...overrides,
  };
}

/** The plan the draft route validates and stores; one buy rule against the AAPLc oracle. */
export const DRAFT_PLAN = {
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

/** The same plan with a sell leg, which a USDC-only spend permission cannot authorize. */
export const SELL_PLAN = {
  params: [],
  nodes: [
    {
      id: "rich",
      op: "gt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "300" },
      ],
    },
  ],
  machines: [
    {
      id: "exit",
      scope: "portfolio",
      initial: "hold",
      states: [
        {
          id: "hold",
          transitions: [
            {
              when: "rich",
              fires: "on_edge",
              to: "hold",
              actions: [
                { action: "order", asset: 0, side: "sell", size: { unit: "base", value: "1" } },
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
  readonly instance: string;
  readonly confirmMessage: string;
};

/**
 * The whole authoring flow: draft, sign the exact stored review, submit.
 *
 * Deliberately not a database seed. The signed artifact is the authority the rest of the system
 * runs on, and the only way to know the API produces one a client can actually sign and submit
 * is to make it produce one and submit it.
 */
export async function commitStrategy(
  harness: ApiHarness,
  identity: TestIdentity,
  options: { mode?: "manual" | "auto"; plan?: unknown; caps?: Record<string, unknown> } = {},
): Promise<Committed> {
  const draft = await call(harness, {
    method: "POST",
    url: "/v1/strategies/draft",
    token: identity.token,
    payload: {
      name: "AAPL entry",
      plan: options.plan ?? DRAFT_PLAN,
      caps: draftCaps(options.caps ?? {}),
      assets: ["AAPLc"],
      mode: options.mode ?? "manual",
    },
  });
  if (draft.statusCode !== 201)
    throw new Error(`draft failed: ${draft.statusCode} ${draft.body.slice(0, 200)}`);
  const body = draft.json<{ artifact_id: string; confirm_message: string }>();
  const signature = harness.chain.sign(identity.wallet, body.confirm_message);
  const created = await call(harness, {
    method: "POST",
    url: "/v1/strategies",
    token: identity.token,
    payload: { artifact_id: body.artifact_id, signature },
  });
  if (created.statusCode !== 201)
    throw new Error(`commit failed: ${created.statusCode} ${created.body.slice(0, 200)}`);
  return {
    artifactId: body.artifact_id,
    instance: created.json<{ instance: string }>().instance,
    confirmMessage: body.confirm_message,
  };
}
