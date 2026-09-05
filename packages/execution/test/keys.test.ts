import { expect, test } from "bun:test";
import { inspect } from "node:util";
import type { Hex } from "@mandate/contracts";
import { Problem } from "@mandate/contracts";
import {
  CUSTODY_DISCLOSURE,
  custodial,
  custody,
  Redactor,
  SpenderKey,
  takeEnvKey,
} from "../src/keys/index.js";

// A real-shaped throwaway key. It controls nothing and is never used to sign.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const derive = () => ADDRESS as Hex;

/** The rejection value, without widening the type to include the resolved SpenderKey. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

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

test("a loaded key exposes its address and nothing else", async () => {
  const key = await SpenderKey.load({ material: KEY, expectedAddress: ADDRESS, derive });
  expect(key.address).toBe(ADDRESS);
  const surfaces = [
    JSON.stringify(key),
    String(key),
    `${key}`,
    inspect(key, { showHidden: true, depth: 5 }),
    JSON.stringify({ config: { spenderKey: key } }),
    Object.getOwnPropertyNames(key).join(","),
  ];
  for (const surface of surfaces) expect(surface).not.toContain(KEY.slice(2));
  expect(JSON.parse(JSON.stringify(key))).toEqual({ spender: ADDRESS, key: "[redacted]" });
});

test("only the callback ever sees the material, and only while it runs", async () => {
  const key = await SpenderKey.load({ material: KEY, derive });
  expect(await key.use("sign", (material) => material)).toBe(KEY);
  key.forget();
  expect(key.released).toBe(true);
  await expect(key.use("sign", (material) => material)).rejects.toThrow(Problem);
});

test("an error thrown out of a signing callback carries no key material", async () => {
  const key = await SpenderKey.load({ material: KEY, derive });
  const leak = new Error(`invalid hex value "${KEY}"`, {
    cause: new Error(`while parsing ${KEY}`),
  });
  const caught = await key
    .use("sign fund transaction", () => {
      throw leak;
    })
    .catch((error: unknown) => error as Error);
  expect(caught.message).toBe('sign fund transaction: invalid hex value "[redacted]"');
  expect(inspect(caught, { depth: 6 })).not.toContain(KEY.slice(2));
});

test("a key that derives a different address than configured is refused", async () => {
  const wrong = SpenderKey.load({
    material: KEY,
    expectedAddress: "0x1111111111111111111111111111111111111111",
    derive,
  });
  await expect(wrong).rejects.toThrow(/controls 0x70997970/);
  // Both values in that message are public addresses; neither is the key.
  const problem = await caught(wrong);
  expect(problem).toBeInstanceOf(Problem);
  expect((problem as Problem).status).toBe(503);
  expect((problem as Problem).detail).not.toContain(KEY.slice(2));
});

test("an invalid scalar is rejected before any library is handed the key", async () => {
  let derived = 0;
  const counting = () => {
    derived += 1;
    return ADDRESS as Hex;
  };
  const order = "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
  await expect(SpenderKey.load({ material: order, derive: counting })).rejects.toThrow(Problem);
  await expect(
    SpenderKey.load({ material: `0x${"0".repeat(64)}`, derive: counting }),
  ).rejects.toThrow(Problem);
  await expect(SpenderKey.load({ material: "0xabc", derive: counting })).rejects.toThrow(Problem);
  expect(derived).toBe(0);
});

test("a derive failure surfaces as a Problem with a scrubbed cause", async () => {
  const failing = () => {
    throw new Error(`InvalidHexError: ${KEY}`);
  };
  const error = (await caught(SpenderKey.load({ material: KEY, derive: failing }))) as Problem & {
    cause?: Error;
  };
  expect(error).toBeInstanceOf(Problem);
  expect(inspect(error, { depth: 6 })).not.toContain(KEY.slice(2));
  expect(error.cause?.message).toBe("InvalidHexError: [redacted]");
});

test("taking a key out of an environment removes it from that environment", () => {
  const env: Record<string, string | undefined> = { WORKER_PRIVATE_KEY: KEY, OTHER: "keep" };
  expect(takeEnvKey(env, "WORKER_PRIVATE_KEY")).toBe(KEY);
  expect("WORKER_PRIVATE_KEY" in env).toBe(false);
  expect(JSON.stringify(env)).not.toContain(KEY.slice(2));
  expect(takeEnvKey(env, "WORKER_PRIVATE_KEY")).toBeUndefined();
  expect(takeEnvKey({ EMPTY: "" }, "EMPTY")).toBeUndefined();
});

test("custody reports the server-held window as custodial and an unsettled pull as unknown", () => {
  const amount = 100_000000n;
  const funded = custody([{ leg: "fund", status: "confirmed", confirmedAt: new Date(1) }], amount);
  expect(funded.holder).toBe("spender");
  expect(funded.exposure).toBe(amount);
  expect(custodial(funded)).toBe(true);

  // In flight: not knowing where the money is must never be reported as "the user has it".
  const inFlight = custody([{ leg: "fund", status: "signed" }], amount);
  expect(inFlight.holder).toBe("unknown");
  expect(inFlight.exposure).toBe(amount);
  expect(custodial(inFlight)).toBe(true);

  // A reverted fund moved nothing, so the user never stopped holding their own USDC.
  const reverted = custody([{ leg: "fund", status: "reverted" }], amount);
  expect(reverted.holder).toBe("account");
  expect(reverted.exposure).toBe(0n);
  expect(custodial(reverted)).toBe(false);

  const settled = custody(
    [
      { leg: "fund", status: "confirmed", confirmedAt: new Date(1) },
      { leg: "swap", status: "confirmed", confirmedAt: new Date(2) },
    ],
    amount,
  );
  expect(settled.holder).toBe("account");
  expect(settled.exposure).toBe(0n);
});

test("the custody disclosure says plainly that the flow is not non-custodial", () => {
  expect(CUSTODY_DISCLOSURE).toContain("not non-custodial");
  expect(CUSTODY_DISCLOSURE).toContain("wallet this service controls");
});
