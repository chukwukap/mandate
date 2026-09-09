/**
 * Secret names that must never reach a log, wherever they appear in the object.
 *
 * Kept separate from the fixed paths below because these need depth wildcards and those do not.
 */
const secretNames = [
  "signature",
  "privateKey",
  "spenderKey",
  "databaseUrl",
  "anthropicKey",
  "privyAppSecret",
  // The worker's Privy credential is nested: `config.privy.{appSecret, authorizationKey}`. The
  // authorization key signs from every wallet users have delegated, which makes it the single
  // most damaging string this process holds.
  "appSecret",
  "authorizationKey",
  "accessToken",
  "rawTransaction",
  "typed_data",
  // Hosted Base providers put the API key in the URL itself — Alchemy as a path segment, Helius
  // as a query parameter. So the endpoint is a credential, not just an address, and logging a
  // config object hands out a billable, rate-limited key. Censored by origin rather than removed
  // entirely: which provider is in use is the first thing anyone asks when the chain is slow.
  "rpcUrl",
  "BASE_RPC_URL",
];

/**
 * How many levels below the root a secret is still caught.
 *
 * Pino's redact paths are ROOT-ANCHORED: "privateKey" matches `{ privateKey }` and nothing else.
 * That is not a theoretical gap. WorkerChain is declared
 * `constructor(private readonly config: WorkerConfig, …)`, and TypeScript's `private` is a
 * compile-time marker — at runtime it is an ordinary enumerable property. So `log.info({ chain })`
 * serialises `chain.config.privateKey`, and the old path list did not match it.
 *
 * Reproduced against pino 10.3.1 before this change: a key at the root was redacted, while
 * `{ config: { privateKey } }` and `{ chain: { config: { privateKey } } }` were both printed in
 * full.
 *
 * Pino has no unbounded-depth wildcard, so this is a bounded sweep rather than a guarantee.
 * Three levels covers every shape this codebase logs — a handler logging an injected service that
 * holds a config that holds a key. The real defence is still not putting secrets in log objects;
 * this is the net under that, and `Redactor` in @mandate/execution keeps what it scrubs in a
 * `#private` field precisely so it cannot be reached by any of this.
 */
const DEPTH = 3;

const atEveryDepth = (name: string) =>
  Array.from({ length: DEPTH + 1 }, (_, level) => `${"*.".repeat(level)}${name}`);

/** Never log request bodies: they can contain wallet signatures and signed transactions. */
export const secretPaths = [
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers['x-mandate-csrf']",
  "res.headers['set-cookie']",
  "body",
  "req.body",
  ...secretNames.flatMap(atEveryDepth),
];

/**
 * Replace a secret with something safe, keeping whatever is safe to keep.
 *
 * A URL keeps its origin: "https://base-mainnet.g.alchemy.com/v2/[REDACTED]" still answers "which
 * provider, which network" without handing over the key. Everything else is replaced whole,
 * because for a private key or a bearer token there is no safe prefix to keep.
 */
function censor(value: unknown): string {
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    try {
      return `${new URL(value).origin}/[REDACTED]`;
    } catch {
      // Not parseable as a URL after all; fall through and redact the whole thing.
    }
  }
  return "[REDACTED]";
}

export function loggerOptions(level: string) {
  return { level, redact: { paths: secretPaths, censor } };
}
