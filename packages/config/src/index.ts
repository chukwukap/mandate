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
  /*
   * Text authoring works with any of three providers, and needs only a key: models are defaulted
   * per provider in @mandate/strategy. Whichever key is set turns the feature on; AI_PROVIDER
   * only matters when several are configured and one has to win.
   *
   * OPENAI_BASE_URL is the reason the OpenAI adapter is worth more than its name suggests —
   * Groq, Together, OpenRouter, DeepSeek, Fireworks and a local Ollama all speak the same
   * chat-completions shape, so a base URL is the whole of the integration for any of them.
   */
  ANTHROPIC_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_BASE_URL: z.url().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().optional(),
  GOOGLE_BASE_URL: z.url().optional(),
  AI_PROVIDER: z.enum(["anthropic", "openai", "google"]).optional(),
  /**
   * The Privy signer (key quorum) users delegate their embedded wallet to. Without it the app
   * still works as signals only: nothing can be armed for automatic buying.
   */
  PRIVY_KEY_QUORUM_ID: z.string().min(1).optional(),
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
  // Naming a provider whose key is absent is a misconfiguration, not a fallback: silently using
  // a different vendor than the operator asked for is worse than refusing to start.
  const aiKeys = {
    anthropic: parsed.ANTHROPIC_API_KEY,
    openai: parsed.OPENAI_API_KEY,
    google: parsed.GOOGLE_API_KEY,
  } as const;
  if (parsed.AI_PROVIDER && !aiKeys[parsed.AI_PROVIDER])
    throw new Error(
      `AI_PROVIDER is "${parsed.AI_PROVIDER}" but its API key is not set. Set the matching key or unset AI_PROVIDER.`,
    );
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
    ai: {
      provider: parsed.AI_PROVIDER,
      anthropicKey: parsed.ANTHROPIC_API_KEY,
      anthropicModel: parsed.ANTHROPIC_MODEL,
      openaiKey: parsed.OPENAI_API_KEY,
      openaiModel: parsed.OPENAI_MODEL,
      openaiBaseUrl: parsed.OPENAI_BASE_URL,
      googleKey: parsed.GOOGLE_API_KEY,
      googleModel: parsed.GOOGLE_MODEL,
      googleBaseUrl: parsed.GOOGLE_BASE_URL,
    },
    privySignerId: parsed.PRIVY_KEY_QUORUM_ID,
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
