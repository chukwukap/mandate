import { isIP } from "node:net";
import { z } from "zod";

const flag = z
  .enum(["0", "1"])
  .default("0")
  .transform((v) => v === "1");
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  APP_ORIGIN: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.url(),
  BASE_RPC_URL: z.url().default("https://mainnet.base.org"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  SPENDER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  ELIGIBLE_COUNTRIES: z.string().default(""),
  TRUSTED_PROXY_IPS: z.string().default(""),
  DEV_COUNTRY: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_DOCS: flag,
});

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const clean = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, v === "" ? undefined : v]),
  );
  const parsed = envSchema.parse(clean);
  const origin = new URL(parsed.APP_ORIGIN);
  if (!["http:", "https:"].includes(origin.protocol))
    throw new Error("APP_ORIGIN must use HTTP or HTTPS");
  if (!["http:", "https:"].includes(new URL(parsed.BASE_RPC_URL).protocol))
    throw new Error("BASE_RPC_URL must use HTTP or HTTPS");
  if (Boolean(parsed.ANTHROPIC_API_KEY) !== Boolean(parsed.ANTHROPIC_MODEL))
    throw new Error("Set both ANTHROPIC_API_KEY and ANTHROPIC_MODEL for text authoring");
  if (origin.origin !== parsed.APP_ORIGIN || origin.username || origin.password)
    throw new Error("APP_ORIGIN must be an origin without a path or credentials");
  if (parsed.NODE_ENV === "production" && origin.protocol !== "https:")
    throw new Error("Production APP_ORIGIN must use HTTPS");
  if (!["postgres:", "postgresql:"].includes(new URL(parsed.DATABASE_URL).protocol))
    throw new Error("DATABASE_URL must be PostgreSQL");
  const countries = parsed.ELIGIBLE_COUNTRIES.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c) || ["US", "XX"].includes(c)))
    throw new Error("ELIGIBLE_COUNTRIES must contain explicit eligible non-US ISO country codes");
  const proxies = parsed.TRUSTED_PROXY_IPS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (proxies.some((ip) => !isIP(ip)))
    throw new Error("TRUSTED_PROXY_IPS must contain exact IP addresses");
  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    origin: origin.origin,
    domain: origin.host,
    databaseUrl: parsed.DATABASE_URL,
    rpcUrl: parsed.BASE_RPC_URL,
    anthropicKey: parsed.ANTHROPIC_API_KEY,
    anthropicModel: parsed.ANTHROPIC_MODEL,
    spenderAddress: parsed.SPENDER_ADDRESS,
    privyAppId: parsed.PRIVY_APP_ID,
    privyAppSecret: parsed.PRIVY_APP_SECRET,
    eligibleCountries: countries,
    trustedProxyIps: proxies,
    devCountry: parsed.NODE_ENV === "production" ? undefined : parsed.DEV_COUNTRY,
    logLevel: parsed.LOG_LEVEL,
    docs: parsed.API_DOCS,
    secureCookies: origin.protocol === "https:",
  };
}
export type Config = ReturnType<typeof loadConfig>;

export type { WorkerConfig } from "./worker.js";
export { loadWorkerConfig } from "./worker.js";
