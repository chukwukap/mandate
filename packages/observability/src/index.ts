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
  "accessToken",
  "rawTransaction",
  "typed_data",
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
 * this is the net under that, and SpenderKey in @mandate/execution keeps its material in a
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

export function loggerOptions(level: string) {
  return { level, redact: { paths: secretPaths, censor: "[REDACTED]" } };
}
