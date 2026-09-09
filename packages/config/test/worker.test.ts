import { expect, test } from "bun:test";
import { ZodError } from "zod";
import { loadWorkerConfig } from "../src/index.js";

/**
 * The worker's environment contract.
 *
 * Deliberately a second schema rather than a superset of the API's: the worker holds the Privy
 * authorization key that signs from delegated wallets and the API never does, and giving each
 * process only the variables it needs is what keeps a leak of one environment from being a leak
 * of both.
 *
 * The rule that matters most here is the last gate before real money moves — `WORKER_EXECUTE=1`
 * is the difference between a process that evaluates strategies and one that signs transactions
 * from users' wallets.
 */

/** The only variable with no default. */
const required = { DATABASE_URL: "postgres://mandate_app:hunter2@localhost:5432/mandate" };
const env = (overrides: Record<string, string | undefined> = {}) => ({ ...required, ...overrides });

// Real-shaped values that control nothing. None of these has ever been registered with Privy.
const PRIVY = {
  PRIVY_APP_ID: "app-id",
  PRIVY_APP_SECRET: "privy-secret",
  PRIVY_AUTHORIZATION_KEY: "wallet-auth:authorization-key",
};

function rejected(value: Record<string, string | undefined>): string[] {
  try {
    loadWorkerConfig(value);
  } catch (error) {
    if (error instanceof ZodError) return error.issues.map((issue) => issue.path.join("."));
    throw error;
  }
  throw new Error("expected loadWorkerConfig to reject");
}

test("a minimal worker environment is a dry run with conservative defaults", () => {
  expect(rejected({})).toEqual(["DATABASE_URL"]);
  const config = loadWorkerConfig(env());
  // Not executing is the default in every environment. Trading has to be asked for.
  expect(config.execute).toBe(false);
  expect(config.privy).toBeUndefined();
  expect(config.pollMs).toBe(2000);
  expect(config.maxBatch).toBe(10);
  expect(config.confirmations).toBe(3);
  expect(config.receiptTimeoutMs).toBe(1_800_000);
  expect(config.rpcUrl).toBe("https://mainnet.base.org");
  expect(config.logLevel).toBe("info");
});

/**
 * Live execution needs all three Privy values: the app the wallets belong to, the secret that
 * authenticates to it, and the authorization key of the signer users delegated to. Booting with
 * a subset produces a worker that believes it is trading and fails at the first order — after it
 * has already claimed the instance and written an execution row. Refusing at boot keeps that
 * state from being created at all.
 */
test("live execution requires the whole Privy signer, not part of it", () => {
  const names = Object.keys(PRIVY) as (keyof typeof PRIVY)[];
  // Nothing, and every way of leaving exactly one out.
  const partial = [{}, ...names.map((missing) => ({ ...PRIVY, [missing]: undefined }))];
  for (const subset of partial)
    expect(() => loadWorkerConfig(env({ WORKER_EXECUTE: "1", ...subset }))).toThrow(
      "Live execution requires PRIVY_APP_ID, PRIVY_APP_SECRET and PRIVY_AUTHORIZATION_KEY",
    );
  const live = loadWorkerConfig(env({ WORKER_EXECUTE: "1", ...PRIVY }));
  expect(live.execute).toBe(true);
  expect(live.privy).toEqual({
    appId: "app-id",
    appSecret: "privy-secret",
    authorizationKey: "wallet-auth:authorization-key",
  });
});

test("a partial Privy configuration is no configuration, even in a dry run", () => {
  // The three values are one credential. Surfacing two of them as `privy` would let a caller
  // check `if (config.privy)` and then hand Privy an undefined authorization key at the first
  // signature — the partial object is exactly the shape that check exists to rule out.
  expect(loadWorkerConfig(env({ PRIVY_APP_ID: "app-id" })).privy).toBeUndefined();
  expect(
    loadWorkerConfig(env({ PRIVY_APP_ID: "app-id", PRIVY_APP_SECRET: "privy-secret" })).privy,
  ).toBeUndefined();
  expect(loadWorkerConfig(env(PRIVY)).privy).toEqual({
    appId: "app-id",
    appSecret: "privy-secret",
    authorizationKey: "wallet-auth:authorization-key",
  });
});

test("WORKER_EXECUTE is a strict 0/1 flag", () => {
  // "true" is what someone writes meaning "yes". Read through `=== "1"` it would mean "no", and
  // a worker that was supposed to be trading would sit there evaluating and never place an
  // order. The enum turns that into a boot failure instead of a silent no-op.
  for (const value of ["true", "yes", "on", "2", "01"])
    expect(rejected(env({ WORKER_EXECUTE: value }))).toEqual(["WORKER_EXECUTE"]);
  expect(loadWorkerConfig(env({ WORKER_EXECUTE: "0" })).execute).toBe(false);
});

test("a blank variable behaves as absent here too", () => {
  // Same `.env` blank-line case as the API loader. The Privy values are the ones that matter:
  // `""` fails min(1), so without the normalisation a commented-out authorization key would
  // take the worker down instead of leaving it in its default dry run.
  const config = loadWorkerConfig(
    env({
      WORKER_EXECUTE: "",
      PRIVY_APP_ID: "",
      PRIVY_APP_SECRET: "",
      PRIVY_AUTHORIZATION_KEY: "",
      WORKER_POLL_MS: "",
      WORKER_MAX_BATCH: "",
      WORKER_CONFIRMATIONS: "",
      WORKER_RECEIPT_TIMEOUT_MS: "",
      APP_ORIGIN: "",
      LOG_LEVEL: "",
      ELIGIBLE_COUNTRIES: "",
    }),
  );
  expect(config.execute).toBe(false);
  expect(config.privy).toBeUndefined();
  expect(config.pollMs).toBe(2000);
  expect(config.confirmations).toBe(3);
  expect(config.origin).toBe("http://localhost:3000");
  expect(config.eligibleCountries).toEqual([]);
});

/**
 * Every numeric bound, at the edge. These are not arbitrary: each one is the point past which a
 * plausible-looking value produces a worker that is wrong rather than one that is slow.
 */
test("the polling and confirmation bounds are enforced at their edges", () => {
  // Below 250ms the poll loop hammers Postgres and the RPC for no gain; above a minute a due
  // strategy waits long enough that the price it was evaluated against is gone.
  expect(rejected(env({ WORKER_POLL_MS: "249" }))).toEqual(["WORKER_POLL_MS"]);
  expect(rejected(env({ WORKER_POLL_MS: "60001" }))).toEqual(["WORKER_POLL_MS"]);
  expect(loadWorkerConfig(env({ WORKER_POLL_MS: "250" })).pollMs).toBe(250);

  // One confirmation is a receipt, not a settlement: Base reorgs of a single block happen, and
  // recording a swap as confirmed from one block is how the journal ends up describing a
  // transaction that no longer exists. The floor of 2 is what makes that unrepresentable.
  expect(rejected(env({ WORKER_CONFIRMATIONS: "1" }))).toEqual(["WORKER_CONFIRMATIONS"]);
  expect(rejected(env({ WORKER_CONFIRMATIONS: "65" }))).toEqual(["WORKER_CONFIRMATIONS"]);
  expect(loadWorkerConfig(env({ WORKER_CONFIRMATIONS: "2" })).confirmations).toBe(2);

  // A batch is claimed under one lease; 100 instances is already more than a cycle can evaluate
  // inside a heartbeat, and 0 would be a worker that claims nothing and looks healthy doing it.
  expect(rejected(env({ WORKER_MAX_BATCH: "0" }))).toEqual(["WORKER_MAX_BATCH"]);
  expect(rejected(env({ WORKER_MAX_BATCH: "101" }))).toEqual(["WORKER_MAX_BATCH"]);

  // Under a minute the worker would abandon transactions that are merely queued, leaving a
  // signed nonce in flight with nothing watching it; over a day nothing is watching either.
  expect(rejected(env({ WORKER_RECEIPT_TIMEOUT_MS: "59999" }))).toEqual([
    "WORKER_RECEIPT_TIMEOUT_MS",
  ]);
  expect(rejected(env({ WORKER_RECEIPT_TIMEOUT_MS: "86400001" }))).toEqual([
    "WORKER_RECEIPT_TIMEOUT_MS",
  ]);
  expect(loadWorkerConfig(env({ WORKER_RECEIPT_TIMEOUT_MS: "86400000" })).receiptTimeoutMs).toBe(
    86_400_000,
  );
});

test("the worker enforces the same origin, database and jurisdiction rules as the API", () => {
  // Same rules, separate implementation: the two loaders share no code, so these assertions are
  // what stops the worker from accepting an environment the API would refuse — which would put
  // the two processes in different jurisdictions or different databases without anyone noticing.
  expect(() => loadWorkerConfig(env({ APP_ORIGIN: "https://app.example.com/" }))).toThrow(
    "APP_ORIGIN must be an HTTP origin",
  );
  expect(() => loadWorkerConfig(env({ APP_ORIGIN: "ftp://app.example.com" }))).toThrow(
    "APP_ORIGIN must be an HTTP origin",
  );
  expect(() => loadWorkerConfig(env({ NODE_ENV: "production" }))).toThrow(
    "Production APP_ORIGIN must use HTTPS",
  );
  expect(() => loadWorkerConfig(env({ DATABASE_URL: "mysql://u:p@localhost/mandate" }))).toThrow(
    "DATABASE_URL must be PostgreSQL",
  );
  expect(() => loadWorkerConfig(env({ BASE_RPC_URL: "ws://node.example.com" }))).toThrow(
    "BASE_RPC_URL must use HTTP(S)",
  );
  for (const value of ["US", "XX", "gb", "GBR"])
    expect(() => loadWorkerConfig(env({ ELIGIBLE_COUNTRIES: value }))).toThrow(
      "Explicit non-US eligible country codes required",
    );
  expect(loadWorkerConfig(env({ ELIGIBLE_COUNTRIES: " GB , NG " })).eligibleCountries).toEqual([
    "GB",
    "NG",
  ]);
});

test("a production worker configuration is loaded whole", () => {
  const config = loadWorkerConfig(
    env({
      NODE_ENV: "production",
      APP_ORIGIN: "https://app.example.com",
      BASE_RPC_URL: "https://base-mainnet.example.com/v2/rpc-key",
      WORKER_EXECUTE: "1",
      ...PRIVY,
      ELIGIBLE_COUNTRIES: "GB",
      WORKER_POLL_MS: "5000",
      LOG_LEVEL: "warn",
    }),
  );
  expect(config).toEqual({
    env: "production",
    ignoreSession: false,
    databaseUrl: required.DATABASE_URL,
    rpcUrl: "https://base-mainnet.example.com/v2/rpc-key",
    origin: "https://app.example.com",
    execute: true,
    eligibleCountries: ["GB"],
    privy: {
      appId: "app-id",
      appSecret: "privy-secret",
      authorizationKey: "wallet-auth:authorization-key",
    },
    pollMs: 5000,
    maxBatch: 10,
    confirmations: 3,
    receiptTimeoutMs: 1_800_000,
    logLevel: "warn",
  });
  /**
   * The secret and the authorization key are ordinary enumerable string properties one level
   * below the root of this object. That is why @mandate/observability redacts `appSecret` and
   * `authorizationKey` below the root as well as at it: anything that logs a value holding this
   * config — a chain client, a worker instance — would otherwise print them.
   * `packages/observability/test/redaction.test.ts` asserts that net actually holds.
   */
  expect(Object.keys(config.privy ?? {})).toEqual(["appId", "appSecret", "authorizationKey"]);
  expect(JSON.stringify(config)).toContain("wallet-auth:authorization-key");
});

test("the session override cannot be switched on in production", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/mandate",
    APP_ORIGIN: "https://app.example.com",
    BASE_RPC_URL: "https://base-mainnet.example.com/v2/rpc-key",
    ELIGIBLE_COUNTRIES: "GB",
    WORKER_IGNORE_SESSION: "1",
  };
  // The whole point of the flag is that it is unavailable exactly where it would be dangerous.
  // A safety control an environment variable can disable in production is not a safety control.
  expect(loadWorkerConfig({ ...base, NODE_ENV: "production" }).ignoreSession).toBe(false);
  expect(
    loadWorkerConfig({ ...base, NODE_ENV: "development", APP_ORIGIN: "http://localhost:3000" })
      .ignoreSession,
  ).toBe(true);
  expect(
    loadWorkerConfig({
      ...base,
      NODE_ENV: "development",
      APP_ORIGIN: "http://localhost:3000",
      WORKER_IGNORE_SESSION: "0",
    }).ignoreSession,
  ).toBe(false);
});
