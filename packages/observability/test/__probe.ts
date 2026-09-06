import { createRequire } from "node:module";
import { secretPaths, loggerOptions } from "../src/index.js";

let resolved = "";
try {
  resolved = createRequire(import.meta.url).resolve("pino");
  console.log("resolves directly:", resolved);
} catch (e) {
  console.log("direct resolve failed:", (e as Error).message.slice(0, 100));
}
const req = createRequire(new URL("../../../apps/worker/package.json", import.meta.url));
console.log("via worker:", req.resolve("pino"));
// biome-ignore lint: probe
const pino = req("pino") as typeof import("pino").pino;
console.log("paths:", JSON.stringify(secretPaths));

const lines: string[] = [];
const stream = { write: (s: string) => { lines.push(s); } };
let log: any;
try {
  log = pino({ ...loggerOptions("info"), base: null, timestamp: false }, stream as any);
  console.log("constructed OK");
} catch (e) {
  console.log("PINO REJECTED OPTIONS:", (e as Error).message);
  process.exit(1);
}
const KEY = "0x" + "ab".repeat(32);
log.info({ privateKey: KEY }, "d0");
log.info({ config: { privateKey: KEY } }, "d1");
log.info({ chain: { config: { privateKey: KEY } } }, "d2");
log.info({ a: { chain: { config: { privateKey: KEY } } } }, "d3");
log.info({ z: { a: { chain: { config: { privateKey: KEY } } } } }, "d4");
log.info({ body: { signature: KEY } }, "body");
log.info({ req: { headers: { cookie: "session=abc", authorization: "Bearer t", "x-mandate-csrf": "c" } } }, "headers");
log.info({ signature: "sig", accessToken: "tok", typed_data: { x: 1 } }, "roots");
log.info({ arr: [{ privateKey: KEY }] }, "array");
for (const l of lines) console.log(l.trim());
