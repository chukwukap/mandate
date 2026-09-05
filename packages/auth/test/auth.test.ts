import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyAccessToken } from "@privy-io/node";
import {
  eligible,
  jurisdiction,
  PrivyAuthenticator,
  type PrivyReader,
  selectWallet,
} from "../src/index.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
function token(overrides: Record<string, unknown> = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const data = [
    { alg: "ES256", typ: "JWT" },
    {
      iss: "privy.io",
      aud: "test-app",
      sub: "did:privy:alice",
      sid: "session1",
      iat: now,
      exp: now + 600,
      ...overrides,
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${data}.${sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
function reader(): PrivyReader {
  return {
    verify: (access_token) =>
      verifyAccessToken({ access_token, app_id: "test-app", verification_key: publicKey }),
    user: async (id) => ({
      id,
      linked_accounts: [
        { type: "wallet", chain_type: "ethereum", address },
        { type: "wallet", chain_type: "solana", address: other },
        { type: "email", address: "alice@example.com" },
      ],
    }),
  };
}
function auth(source = reader()) {
  return new PrivyAuthenticator("test-app", source);
}

describe("Privy access-token boundary (real SDK cryptographic verification)", () => {
  test("valid signed token resolves only linked Ethereum wallets", async () => {
    expect(await auth().authenticate(`Bearer ${token()}`)).toEqual({
      privyDid: "did:privy:alice",
      sessionId: "session1",
      wallets: [address],
    });
  });
  for (const [name, overrides] of Object.entries({
    expired: { exp: 1 },
    audience: { aud: "another-app" },
    issuer: { iss: "attacker" },
    session: { sid: undefined },
    future: { iat: Math.floor(Date.now() / 1000) + 3600 },
    subject: { sub: "not-a-privy-user" },
  })) {
    test(`rejects ${name}`, async () => {
      await expect(auth().authenticate(`Bearer ${token(overrides)}`)).rejects.toMatchObject({
        status: 401,
      });
    });
  }
  test("rejects a forged signature", async () => {
    const impostor = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await expect(
      auth().authenticate(`Bearer ${token({}, impostor.privateKey)}`),
    ).rejects.toMatchObject({ status: 401 });
  });
  test("malformed credentials never call upstream", async () => {
    const source = reader();
    source.verify = () => {
      throw new Error("Should not be called");
    };
    for (const header of [
      undefined,
      "Bearer",
      "Basic abc",
      "Bearer a.b.c extra",
      `Bearer ${"a".repeat(20000)}.b.c`,
    ]) {
      await expect(auth(source).authenticate(header)).rejects.toMatchObject({ status: 401 });
    }
  });
  test("rejects mismatched user data", async () => {
    const source = reader();
    source.user = async () => ({ id: "did:privy:bob", linked_accounts: [] });
    await expect(auth(source).authenticate(`Bearer ${token()}`)).rejects.toMatchObject({
      status: 401,
    });
  });
  test("verification service and user lookup outages return 503", async () => {
    for (const method of ["verify", "user"] as const) {
      const source = reader();
      source[method] = async () => {
        throw new Error("upstream secret must not escape");
      };
      await expect(auth(source).authenticate(`Bearer ${token()}`)).rejects.toMatchObject({
        status: 503,
      });
    }
  });
  test("never treats an arbitrary requested wallet as proof of ownership", () => {
    const user = {
      privyDid: "did:privy:alice",
      sessionId: "s",
      wallets: [address] as `0x${string}`[],
    };
    expect(selectWallet(user)).toBe(address);
    expect(() => selectWallet(user, other)).toThrow("Link this Ethereum wallet");
    expect(() => selectWallet({ ...user, wallets: [address, other] })).toThrow("Select a linked");
    expect(() => selectWallet({ ...user, wallets: [] })).toThrow("Select a linked");
  });
});

test("eligibility cannot be spoofed with a direct geographic header", () => {
  const input = {
    remoteIp: "127.0.0.1",
    countryHeader: "GB",
    trustedProxyIps: ["10.0.0.1"],
    production: true,
    devCountry: "GB",
  };
  expect(jurisdiction(input)).toBe("XX");
  expect(jurisdiction({ ...input, remoteIp: "10.0.0.1" })).toBe("GB");
  expect(eligible("US", ["US"])).toBe(false);
  expect(eligible("XX", ["XX"])).toBe(false);
  expect(eligible("GB", [])).toBe(false);
  expect(eligible("GB", ["GB"])).toBe(true);
});
