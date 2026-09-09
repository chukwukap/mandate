import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { Redactor } from "../src/keys/index.js";

/**
 * The worker signs nothing locally any more — a user's Privy embedded wallet signs its own
 * orders through the app's delegated signer — but it still holds a Privy authorization key and
 * handles signed transaction bytes, and the value-based scrub is what keeps either out of a log
 * line assembled from an upstream error. The fixture is a real-shaped key so the variants the
 * redactor must recognise (bare, prefixed, either case) are the ones a library would emit.
 */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

test("a redactor strips every spelling of a secret and bounds what it emits", () => {
  const redactor = new Redactor([KEY]);
  const bare = KEY.slice(2);
  expect(redactor.text(`key=${KEY}`)).toBe("key=[redacted]");
  expect(redactor.text(`key=${bare}`)).toBe("key=[redacted]");
  expect(redactor.text(`key=${bare.toUpperCase()}`)).toBe("key=[redacted]");
  expect(redactor.text(`0X${bare}`)).toBe("[redacted]");
  // The prefixed form must be consumed whole; a leftover "0x" would still advertise the shape.
  expect(redactor.text(`... ${KEY} ...`)).not.toContain("0x");
  expect(redactor.text("a".repeat(9000)).length).toBeLessThanOrEqual(4000);
});

test("a redactor refuses to treat a short string as a secret", () => {
  // Otherwise a placeholder like "0x0" would blank out unrelated text everywhere.
  expect(new Redactor(["0x0"]).text("0x0 and 0x0abc")).toBe("0x0 and 0x0abc");
  expect(new Redactor([]).empty).toBe(true);
});

test("a secret that is not hex is still scrubbed in every form it was given", () => {
  // A Privy authorization key is base64, not hex. The variants logic must not assume a 0x
  // prefix exists to strip, or a non-hex secret would only match its exact spelling.
  const authorization = "wallet-auth:MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg";
  const redactor = new Redactor([authorization]);
  expect(redactor.text(`Authorization: ${authorization}`)).toBe("Authorization: [redacted]");
  expect(redactor.text(authorization.toLowerCase())).toBe("[redacted]");
});

test("scrubbing an error covers the message, the stack, the cause chain and string fields", () => {
  const redactor = new Redactor([KEY]);
  const inner = new Error(`eth_sendRawTransaction failed for ${KEY}`);
  const outer = new Error(`request failed: ${KEY}`, { cause: inner });
  Object.assign(outer, {
    details: `signer ${KEY}`,
    request: { body: KEY },
    status: 500,
  });
  const scrubbed = redactor.error(outer);
  const rendered = inspect(scrubbed, { depth: 6 });
  expect(rendered).not.toContain(KEY.slice(2));
  expect(scrubbed.message).toBe("request failed: [redacted]");
  expect((scrubbed as { details?: string }).details).toBe("signer [redacted]");
  expect((scrubbed as { status?: number }).status).toBe(500);
  // Object-valued fields are dropped rather than copied: that is where a library parks the
  // request it was about to send.
  expect((scrubbed as { request?: unknown }).request).toBeUndefined();
  expect((scrubbed.cause as Error).message).toBe("eth_sendRawTransaction failed for [redacted]");
  expect(scrubbed.stack ?? "").not.toContain(KEY.slice(2));
});

test("a thrown non-Error is never stringified into an error message", () => {
  const redactor = new Redactor([KEY]);
  const scrubbed = redactor.error({ serializedTransaction: KEY });
  expect(scrubbed.message).toBe("Non-error value thrown (object)");
});

test("a scrub that cannot read the error discards it rather than passing it through", () => {
  const redactor = new Redactor([KEY]);
  const hostile = new Error(`boom ${KEY}`);
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("no");
    },
  });
  const scrubbed = redactor.error(hostile);
  expect(scrubbed.message).toContain("discarded unread");
  expect(inspect(scrubbed, { depth: 6 })).not.toContain(KEY.slice(2));
});
