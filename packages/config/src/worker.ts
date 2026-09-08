import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url(),
  APP_ORIGIN: z.url().default("http://localhost:3000"),
  BASE_RPC_URL: z.url().default("https://mainnet.base.org"),
  WORKER_EXECUTE: z.enum(["0", "1"]).default("0"),
  ELIGIBLE_COUNTRIES: z.string().default(""),
  WORKER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  SPENDER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
  WORKER_MAX_BATCH: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_CONFIRMATIONS: z.coerce.number().int().min(2).max(64).default(3),
  WORKER_RECEIPT_TIMEOUT_MS: z.coerce.number().int().min(60000).max(86400000).default(1800000),
  /**
   * Trade outside US market hours. Development only — see below.
   *
   * The session window exists so that stale overnight and holiday closing prices cannot admit an
   * order. On a forked chain that reason does not apply: the reference carries a live timestamp,
   * and the independent 300-second freshness check still governs every tick. Without this, the
   * whole execution path can only be exercised between 09:35 and 15:55 ET on a weekday, which
   * makes testing depend on the time of day.
   */
  WORKER_IGNORE_SESSION: z.enum(["0", "1"]).default("0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});
export function loadWorkerConfig(env: Record<string, string | undefined> = process.env) {
  const value = schema.parse(
    Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === "" ? undefined : v])),
  );
  const origin = new URL(value.APP_ORIGIN);
  if (origin.origin !== value.APP_ORIGIN || !["http:", "https:"].includes(origin.protocol))
    throw new Error("APP_ORIGIN must be an HTTP origin");
  if (!["postgres:", "postgresql:"].includes(new URL(value.DATABASE_URL).protocol))
    throw new Error("DATABASE_URL must be PostgreSQL");
  if (!["http:", "https:"].includes(new URL(value.BASE_RPC_URL).protocol))
    throw new Error("BASE_RPC_URL must use HTTP(S)");
  const execute = value.WORKER_EXECUTE === "1";
  const countries = value.ELIGIBLE_COUNTRIES.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c) || ["US", "XX"].includes(c)))
    throw new Error("Explicit non-US eligible country codes required");
  if (execute && (!value.WORKER_PRIVATE_KEY || !value.SPENDER_ADDRESS))
    throw new Error("Live execution requires WORKER_PRIVATE_KEY and SPENDER_ADDRESS");
  if (value.NODE_ENV === "production" && origin.protocol !== "https:")
    throw new Error("Production APP_ORIGIN must use HTTPS");
  return {
    env: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    rpcUrl: value.BASE_RPC_URL,
    origin: value.APP_ORIGIN,
    execute,
    privateKey: value.WORKER_PRIVATE_KEY,
    eligibleCountries: countries,
    spender: value.SPENDER_ADDRESS,
    pollMs: value.WORKER_POLL_MS,
    maxBatch: value.WORKER_MAX_BATCH,
    confirmations: value.WORKER_CONFIRMATIONS,
    receiptTimeoutMs: value.WORKER_RECEIPT_TIMEOUT_MS,
    // Forced off in production, the same way devCountry is in the API config. A safety control
    // that can be switched off by an environment variable in production is not a safety control.
    ignoreSession: value.NODE_ENV !== "production" && value.WORKER_IGNORE_SESSION === "1",
    logLevel: value.LOG_LEVEL,
  };
}
export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
