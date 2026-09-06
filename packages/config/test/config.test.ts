import { expect, test } from "bun:test";
import { ZodError } from "zod";
import { loadConfig } from "../src/index.js";

/**
 * The API's environment contract.
 *
 * Every value here is typed once into a `.env` file or a deployment secret and then never looked
 * at again, so the loader's real job is to refuse the near-misses at boot rather than to run a
 * service that is subtly wrong for a month. Most of these assertions are therefore about what is
 * REJECTED, and about the exact shape of the object the rest of the API then trusts without
 * re-checking.
 *
 * `loadConfig` is called with an explicit environment object rather than left to read
 * `process.env`: a test that mutated the real environment would leak into every other file bun
 * runs in the same process.
 */

/** The only three variables with no default. Everything else is optional or defaulted. */
const required = {
  DATABASE_URL: "postgres://mandate_app:hunter2@localhost:5432/mandate",
  PRIVY_APP_ID: "app-id",
  PRIVY_APP_SECRET: "privy-secret",
};
const env = (overrides: Record<string, string | undefined> = {}) => ({ ...required, ...overrides });

/** The variables zod rejected, by name, so a test can assert the whole set at once. */
function rejected(value: Record<string, string | undefined>): string[] {
  try {
    loadConfig(value);
  } catch (error) {
    if (error instanceof ZodError) return error.issues.map((issue) => issue.path.join("."));
    throw error;
  }
  throw new Error("expected loadConfig to reject");
}

/** The message of whatever `loadConfig` threw, for asserting on what a boot failure prints. */
function messageOf(value: Record<string, string | undefined>): string {
  try {
    loadConfig(value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected loadConfig to reject");
}

test("a boot with nothing configured names every missing variable at once", () => {
  // zod collects issues instead of throwing on the first one, and that is the difference between
  // one failed deploy that lists three variables and three failed deploys that each list one.
  expect(rejected({})).toEqual(["DATABASE_URL", "PRIVY_APP_ID", "PRIVY_APP_SECRET"]);
  // Nothing else is required: a minimal environment boots on the defaults.
  expect(loadConfig(env()).env).toBe("development");
});

/**
 * The single most common malformed environment is not a typo, it is a blank line: `LOG_LEVEL=`
 * in a `.env` file, or a deployment secret that was created but never filled in. Both arrive as
 * `""`, which is a perfectly good string and would satisfy `z.string()`, pass `min(1)` only by
 * accident of the schema, and fail every regex. Normalising `""` to undefined before parsing is
 * what makes a blank behave as "not set" — the thing the operator meant.
 */
test("a blank variable behaves as absent, not as an empty value", () => {
  // Blank where a value is required is still a missing variable, reported under its own name.
  expect(rejected(env({ PRIVY_APP_ID: "" }))).toEqual(["PRIVY_APP_ID"]);

  const config = loadConfig(
    env({
      APP_ORIGIN: "",
      PORT: "",
      LOG_LEVEL: "",
      API_DOCS: "",
      DEV_COUNTRY: "",
      SPENDER_ADDRESS: "",
      ELIGIBLE_COUNTRIES: "",
      TRUSTED_PROXY_IPS: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
    }),
  );
  expect(config.origin).toBe("http://localhost:3000");
  expect(config.port).toBe(8080);
  expect(config.logLevel).toBe("info");
  expect(config.docs).toBe(false);
  // DEV_COUNTRY and SPENDER_ADDRESS are regex-validated. `""` matches neither pattern, so if the
  // normalisation were removed these two would fail the parse rather than fall back to absent —
  // which is precisely how a blank in a deployment template takes an API down.
  expect(config.devCountry).toBeUndefined();
  expect(config.spenderAddress).toBeUndefined();
  expect(config.anthropicKey).toBeUndefined();
  expect(config.anthropicModel).toBeUndefined();
  expect(config.eligibleCountries).toEqual([]);
  expect(config.trustedProxyIps).toEqual([]);

  // And the normalisation feeds the cross-field rules: a key with a blank model is a half-filled
  // pair, not a configured one, so it is refused rather than used to call Anthropic with "".
  expect(() => loadConfig(env({ ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_MODEL: "" }))).toThrow(
    "Set both ANTHROPIC_API_KEY and ANTHROPIC_MODEL",
  );
});

/**
 * `origin` is compared byte for byte against the browser's `Origin` header by CORS and used to
 * scope cookies. Anything the URL parser would normalise is refused rather than silently
 * corrected, because a config that says one thing and enforces another is how a CORS allowlist
 * ends up wider than its author believes.
 */
test("APP_ORIGIN must be exactly an origin, byte for byte", () => {
  for (const value of [
    "https://app.example.com/", // A trailing slash: the most common form of this mistake.
    "https://app.example.com/dashboard",
    "https://app.example.com:443", // The default port, which URL drops from `origin`.
    "HTTPS://App.Example.com", // Scheme and host case, which URL lowercases.
  ])
    expect(() => loadConfig(env({ APP_ORIGIN: value }))).toThrow(
      "APP_ORIGIN must be an origin without a path or credentials",
    );

  // A non-default port is part of the origin and survives untouched, as does the derived host.
  const config = loadConfig(env({ APP_ORIGIN: "https://app.example.com:8443" }));
  expect(config.origin).toBe("https://app.example.com:8443");
  expect(config.domain).toBe("app.example.com:8443");
  expect(config.secureCookies).toBe(true);
});

test("a URL carrying credentials is refused, and the refusal does not repeat them", () => {
  const message = messageOf(env({ APP_ORIGIN: "https://ops:hunter2@app.example.com" }));
  expect(message).toBe("APP_ORIGIN must be an origin without a path or credentials");
  // This message is printed by whatever supervises the process at boot, into a log nobody
  // treats as sensitive. Echoing the rejected value would put the password in it.
  expect(message).not.toContain("hunter2");
});

test("only HTTP(S) origins and RPC endpoints are accepted", () => {
  for (const value of ["ftp://app.example.com", "file:///etc/passwd", "javascript:alert(1)"])
    expect(() => loadConfig(env({ APP_ORIGIN: value }))).toThrow(
      "APP_ORIGIN must use HTTP or HTTPS",
    );
  // `z.url()` accepts any parseable URL, including schemes viem's http transport cannot speak.
  // A ws:// endpoint would otherwise fail at the first eth_call rather than at boot.
  expect(() => loadConfig(env({ BASE_RPC_URL: "ws://node.example.com" }))).toThrow(
    "BASE_RPC_URL must use HTTP or HTTPS",
  );
  expect(loadConfig(env({ BASE_RPC_URL: "https://base-mainnet.example.com/v2/k" })).rpcUrl).toBe(
    "https://base-mainnet.example.com/v2/k",
  );
});

test("production refuses a plaintext origin and drops the dev geo override", () => {
  expect(() => loadConfig(env({ NODE_ENV: "production" }))).toThrow(
    "Production APP_ORIGIN must use HTTPS",
  );
  const production = loadConfig(
    env({ NODE_ENV: "production", APP_ORIGIN: "https://app.example.com", DEV_COUNTRY: "NG" }),
  );
  expect(production.secureCookies).toBe(true);
  /**
   * DEV_COUNTRY forges the jurisdiction that `jurisdiction()` would otherwise take from a
   * trusted proxy header. Honouring it in production would let anyone who can set an
   * environment variable trade from a country the service is not licensed in, so the loader
   * drops it here rather than trusting every deployment never to set it.
   */
  expect(production.devCountry).toBeUndefined();
  expect(loadConfig(env({ DEV_COUNTRY: "NG" })).devCountry).toBe("NG");
  // The cookie flag follows the scheme, so the local http origin must not claim Secure — a
  // Secure cookie over plain http is simply never stored, and login silently fails.
  expect(loadConfig(env()).secureCookies).toBe(false);
});

test("DATABASE_URL must be a PostgreSQL URL", () => {
  for (const value of ["mysql://u:p@localhost/mandate", "http://localhost:5432/mandate", "u:p@h/d"])
    expect(() => loadConfig(env({ DATABASE_URL: value }))).toThrow(
      "DATABASE_URL must be PostgreSQL",
    );
  // Both spellings of the scheme are in the wild — libpq emits `postgresql://`, most tooling
  // and every runbook in this repo writes `postgres://` — and pg accepts either.
  for (const scheme of ["postgres", "postgresql"])
    expect(
      loadConfig(env({ DATABASE_URL: `${scheme}://u:p@localhost:5432/mandate` })).databaseUrl,
    ).toBe(`${scheme}://u:p@localhost:5432/mandate`);
});

/**
 * A failed parse is thrown out of `main()` and printed by the supervisor. DATABASE_URL carries
 * the database password, so a validator that quoted the value it rejected would write that
 * password to a log on every failed boot. zod reports the path and the expected format only;
 * this pins that, because it is a property of zod's messages rather than of anything here.
 */
test("a validation failure never echoes the value it rejected", () => {
  const attempt = env({ DATABASE_URL: "postgres//mandate_app:hunter2@localhost/mandate" });
  try {
    loadConfig(attempt);
    throw new Error("expected loadConfig to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    const printed = (error as ZodError).message;
    expect(printed).toContain("DATABASE_URL");
    expect(printed).not.toContain("hunter2");
  }
});

/**
 * Eligibility is an explicit allowlist, and `eligible()` in @mandate/auth independently refuses
 * "US" and "XX". Listing either here would be a config that reads as if it permits something the
 * code will never permit, so the loader refuses them instead of accepting a lie.
 */
test("ELIGIBLE_COUNTRIES is an explicit list of non-US ISO codes", () => {
  for (const value of ["GB,US", "US", "XX", "gb", "GBR", "G1", "GB,,US"])
    expect(() => loadConfig(env({ ELIGIBLE_COUNTRIES: value }))).toThrow(
      "ELIGIBLE_COUNTRIES must contain explicit eligible non-US ISO country codes",
    );
  // Whitespace and a trailing comma are what hand-editing a list produces; both are tolerated.
  expect(loadConfig(env({ ELIGIBLE_COUNTRIES: " GB , NG ," })).eligibleCountries).toEqual([
    "GB",
    "NG",
  ]);
  // Unset means nobody is eligible, not everybody: `eligible()` tests membership, so an empty
  // list denies every request rather than opening the service to every jurisdiction.
  expect(loadConfig(env()).eligibleCountries).toEqual([]);
});

/**
 * `jurisdiction()` trusts the country header only when `trustedProxyIps.includes(remoteIp)` —
 * exact string equality against the peer address. A CIDR block or a hostname can never equal a
 * peer address, so accepting one would not widen the trust, it would silently narrow it to
 * nothing: every request would fall through to "XX" and every user would be told they are
 * ineligible. Failing at boot is the only way that mistake is ever noticed.
 */
test("TRUSTED_PROXY_IPS must be exact addresses, not ranges or names", () => {
  for (const value of ["10.0.0.0/8", "proxy.internal", "203.0.113.5:443", "203.0.113"])
    expect(() => loadConfig(env({ TRUSTED_PROXY_IPS: value }))).toThrow(
      "TRUSTED_PROXY_IPS must contain exact IP addresses",
    );
  // Both families, because a dual-stack load balancer presents whichever it connected over.
  expect(
    loadConfig(env({ TRUSTED_PROXY_IPS: "203.0.113.5, 2001:db8::1" })).trustedProxyIps,
  ).toEqual(["203.0.113.5", "2001:db8::1"]);
});

test("the Anthropic key and model are configured together or not at all", () => {
  // Half a pair is not a degraded authoring feature, it is a request that fails at the first
  // user prompt with an SDK error nobody can read. Refuse at boot instead.
  for (const half of [{ ANTHROPIC_API_KEY: "sk-ant-x" }, { ANTHROPIC_MODEL: "claude-opus-4" }])
    expect(() => loadConfig(env(half))).toThrow(
      "Set both ANTHROPIC_API_KEY and ANTHROPIC_MODEL for text authoring",
    );
  const both = loadConfig(env({ ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_MODEL: "claude-opus-4" }));
  expect(both.anthropicKey).toBe("sk-ant-x");
  expect(both.anthropicModel).toBe("claude-opus-4");
  const neither = loadConfig(env());
  expect(neither.anthropicKey).toBeUndefined();
  expect(neither.anthropicModel).toBeUndefined();
});

test("PORT is a whole port number, and 0 stays available for ephemeral binds", () => {
  for (const value of ["65536", "-1", "8080.5", "8080abc", "abc"])
    expect(rejected(env({ PORT: value }))).toEqual(["PORT"]);
  // Tests and some supervisors ask for port 0 and read back what the OS assigned; rejecting it
  // as falsy would break that, so the bound is min(0) rather than min(1).
  expect(loadConfig(env({ PORT: "0" })).port).toBe(0);
  expect(loadConfig(env({ PORT: "65535" })).port).toBe(65535);
});

test("API_DOCS is a strict 0/1 flag, not a truthiness test", () => {
  // The docs route exposes the whole OpenAPI surface. "true", "yes" and "on" are all things an
  // operator might write meaning "on"; every one of them is refused rather than quietly read as
  // off, which is the failure mode of `value === "1"` against an unvalidated string.
  for (const value of ["true", "yes", "on", "2"])
    expect(rejected(env({ API_DOCS: value }))).toEqual(["API_DOCS"]);
  expect(loadConfig(env({ API_DOCS: "1" })).docs).toBe(true);
  expect(loadConfig(env({ API_DOCS: "0" })).docs).toBe(false);
  expect(loadConfig(env()).docs).toBe(false);
});

test("SPENDER_ADDRESS is a checksum-agnostic 20-byte address or absent", () => {
  for (const value of [`0x${"1".repeat(39)}`, `0x${"1".repeat(41)}`, "1".repeat(40), "0xnothex"])
    expect(rejected(env({ SPENDER_ADDRESS: value }))).toEqual(["SPENDER_ADDRESS"]);
  // Mixed case passes: EIP-55 checksums are exactly that, and the value is compared downstream
  // after lowercasing rather than as typed.
  const mixed = `0x${"aB".repeat(20)}`;
  expect(loadConfig(env({ SPENDER_ADDRESS: mixed })).spenderAddress).toBe(mixed);
});

test("the loaded object is the flat, derived surface the rest of the API reads", () => {
  const config = loadConfig(
    env({
      NODE_ENV: "test",
      HOST: "0.0.0.0",
      PORT: "8081",
      APP_ORIGIN: "http://localhost:3001",
      LOG_LEVEL: "silent",
    }),
  );
  expect(config).toEqual({
    env: "test",
    host: "0.0.0.0",
    port: 8081,
    origin: "http://localhost:3001",
    domain: "localhost:3001",
    databaseUrl: required.DATABASE_URL,
    rpcUrl: "https://mainnet.base.org",
    anthropicKey: undefined,
    anthropicModel: undefined,
    spenderAddress: undefined,
    privyAppId: "app-id",
    privyAppSecret: "privy-secret",
    eligibleCountries: [],
    trustedProxyIps: [],
    devCountry: undefined,
    logLevel: "silent",
    docs: false,
    secureCookies: false,
  });
  // The default RPC endpoint is Base mainnet, chain 8453 — the only chain this system trades on.
  expect(loadConfig(env()).rpcUrl).toBe("https://mainnet.base.org");
});
