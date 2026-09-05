/** Never log request bodies: they can contain wallet signatures and signed transactions. */
export const secretPaths = [
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers['x-mandate-csrf']",
  "res.headers['set-cookie']",
  "signature",
  "privateKey",
  "spenderKey",
  "databaseUrl",
  "anthropicKey",
  "privyAppSecret",
  "accessToken",
  "rawTransaction",
  "typed_data",
  "body",
  "req.body",
];
export function loggerOptions(level: string) {
  return { level, redact: { paths: secretPaths, censor: "[REDACTED]" } };
}
