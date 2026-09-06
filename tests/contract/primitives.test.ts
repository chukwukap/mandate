import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as contracts from "../../packages/contracts/src/index.js";
import * as schemas from "../../packages/contracts/src/schemas/primitives.js";

/**
 * The leaf rules themselves: the layer every response schema in this directory is built out of.
 *
 * Two drifts are asserted here, and both are the kind that produce a bug with no line of code to
 * blame.
 *
 * The first is inside `@mandate/contracts`. `src/index.ts` declares `addressSchema`,
 * `signatureSchema`, `idSchema`, `modeSchema` and `statusSchema` locally, and
 * `src/schemas/primitives.ts` declares the same five again — the first set is what the API
 * routes import and validate requests with, the second is what `src/types/` infers the shared
 * TypeScript vocabulary from. Identical today. Two declarations of one rule do not stay
 * identical, and when they part the type says one thing while the validator does another.
 *
 * The second is between the closed vocabularies and the database. `executions.status`,
 * `instances.status`, `permissions.status`, `transactions.leg` and the rest are each a zod enum
 * AND a `CHECK` constraint, written in two languages in two files. Migration 0004 widened the
 * execution CHECK with `recovery_required`; a copy of the list that had not learned it would
 * have silently excluded a real row from a status filter, which reads to a user as "that order
 * never happened".
 */

/** Values every address rule must agree on, in both directions. */
const ADDRESSES = [
  ["0xb200000000000000000000C2e324d24d7eEcd1fb", true],
  ["0xb200000000000000000000c2e324d24d7eecd1fb", true],
  ["0xB200000000000000000000C2E324D24D7EECD1FB", true],
  ["b200000000000000000000C2e324d24d7eEcd1fb", false],
  ["0xb200000000000000000000C2e324d24d7eEcd1f", false],
  ["0xb200000000000000000000C2e324d24d7eEcd1fbb", false],
  ["0x", false],
  ["", false],
] as const;

const SIGNATURES = [
  [`0x${"ab".repeat(65)}`, true],
  // ERC-6492 wraps a smart-account signature around the factory calldata that would deploy the
  // account, so a Coinbase Smart Wallet signature is kilobytes rather than 65 bytes. A rule
  // capped at 65 would reject exactly the accounts eligible for automatic mode.
  [`0x${"ab".repeat(4000)}`, true],
  // Whole bytes only: an odd nibble count is not signature bytes.
  ["0xabc", false],
  ["0x", false],
  ["not hex", false],
] as const;

const IDS = [
  ["3f6b6e5a-9d3f-4e1a-8a4b-9f2c1d0e7a55", true],
  ["3F6B6E5A-9D3F-4E1A-8A4B-9F2C1D0E7A55", true],
  ["not-a-uuid", false],
  ["3f6b6e5a9d3f4e1a8a4b9f2c1d0e7a55", false],
] as const;

/** `parse` succeeded or did not. The value is irrelevant; only the verdict is compared. */
function accepts(schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) {
  return schema.safeParse(value).success;
}

describe("the two declarations of each shared leaf rule agree", () => {
  test("addressSchema", () => {
    for (const [value, expected] of ADDRESSES) {
      expect(accepts(contracts.addressSchema, value), value).toBe(expected);
      expect(accepts(schemas.addressSchema, value), value).toBe(expected);
    }
  });

  test("signatureSchema", () => {
    for (const [value, expected] of SIGNATURES) {
      const label = value.slice(0, 12);
      expect(accepts(contracts.signatureSchema, value), label).toBe(expected);
      expect(accepts(schemas.signatureSchema, value), label).toBe(expected);
    }
  });

  test("idSchema", () => {
    for (const [value, expected] of IDS) {
      expect(accepts(contracts.idSchema, value), value).toBe(expected);
      expect(accepts(schemas.idSchema, value), value).toBe(expected);
    }
  });

  test("modeSchema and statusSchema hold the same members in the same order", () => {
    // Order matters as well as membership: `EXECUTION_STATUSES` and friends are derived from
    // `.options`, and a caller that renders a filter from that list would silently reorder.
    expect(contracts.modeSchema.options).toEqual(schemas.modeSchema.options);
    expect(contracts.statusSchema.options).toEqual(schemas.statusSchema.options);
    expect([...schemas.modeSchema.options]).toEqual(["manual", "auto"]);
    expect([...schemas.statusSchema.options]).toEqual(["armed", "paused", "halted", "ended"]);
  });
});

describe("the closed vocabularies", () => {
  test("the exported member lists are exactly their schemas' options", () => {
    // `types/enums.ts` builds each list by reading `.options` off the schema that owns it, so a
    // member added to the schema appears in the list in the same commit. Asserted rather than
    // assumed, because the alternative — a hand-written array beside the schema — is what this
    // replaced and what would be re-introduced by anyone adding a member the quick way.
    expect(contracts.MODES).toEqual([...schemas.modeSchema.options]);
    expect(contracts.INSTANCE_STATUSES).toEqual([...schemas.statusSchema.options]);
    expect(contracts.SIDES).toEqual([...schemas.sideSchema.options]);
    expect(contracts.WALLET_KINDS).toEqual([...schemas.walletKindSchema.options]);
    expect(contracts.PERMISSION_STATUSES).toEqual([...schemas.permissionStatusSchema.options]);
    expect(contracts.EXECUTION_STATUSES).toEqual([...schemas.executionStatusSchema.options]);
    expect(contracts.TRANSACTION_LEGS).toEqual([...schemas.transactionLegSchema.options]);
    expect(contracts.TRANSACTION_STATUSES).toEqual([...schemas.transactionStatusSchema.options]);
  });

  test("the lists are frozen, so one careless sort cannot reorder every request's rule", () => {
    // `members()` copies and freezes rather than aliasing `.options`, which is the validator's
    // own array. Handing that out unfrozen would let a call site `sort()` — or `push` — the
    // rule every request in the process is parsed against.
    for (const list of [
      contracts.MODES,
      contracts.INSTANCE_STATUSES,
      contracts.EXECUTION_STATUSES,
      contracts.TRANSACTION_LEGS,
    ])
      expect(Object.isFrozen(list)).toBe(true);
  });

  test("every status has a disposition, and no member is left without one", () => {
    // Exhaustiveness is a compile-time property of these switches; this asserts it at runtime
    // too, because a `default:` added later would satisfy the compiler and quietly answer for a
    // member nobody classified.
    for (const status of contracts.EXECUTION_STATUSES)
      expect(["signalled", "working", "settled", "operator"]).toContain(
        contracts.executionDisposition(status),
      );
    for (const status of contracts.INSTANCE_STATUSES)
      expect(["scheduled", "idle", "terminal"]).toContain(contracts.instanceDisposition(status));
    for (const status of contracts.PERMISSION_STATUSES)
      expect(["unsigned", "signed", "spendable", "terminal"]).toContain(
        contracts.permissionDisposition(status),
      );
  });

  test("`no onchain spend` is drawn tightly and is not the same set as `settled`", () => {
    // A promise made to a user, so its membership is the assertion. `pending` is absent even
    // though a pending order may not have broadcast yet: a signed transaction can still land,
    // and "nothing was spent" must not be claimed about an order that could settle a second
    // later.
    expect([...contracts.NO_ONCHAIN_SPEND_STATUSES]).toEqual(["signal", "admitted", "cancelled"]);
    expect(contracts.guaranteesNoOnchainSpend("pending")).toBe(false);
    expect(contracts.guaranteesNoOnchainSpend("reverted")).toBe(false);
    // `settled` excludes `signal` and `recovery_required` because those are also never advanced
    // but for different reasons; reporting all six as one would hide a stuck order needing an
    // operator among the ordinary completed ones.
    expect([...contracts.SETTLED_EXECUTION_STATUSES]).toEqual([
      "confirmed",
      "reverted",
      "cancelled",
      "refunded",
    ]);
    expect(contracts.isSettledExecutionStatus("recovery_required")).toBe(false);
    expect(contracts.isSettledExecutionStatus("signal")).toBe(false);
  });

  test("the unwind legs are exactly the two that may run after a user has paused", () => {
    expect([...contracts.FORWARD_LEGS]).toEqual(["fund", "approve", "swap"]);
    expect([...contracts.UNWIND_LEGS]).toEqual(["reset", "refund"]);
    // Refusing to refund a paused strategy would strand the user's money in the spender wallet,
    // so unwinding must proceed exactly when the forward path may not.
    for (const leg of contracts.UNWIND_LEGS) expect(contracts.isUnwindLeg(leg)).toBe(true);
    for (const leg of contracts.FORWARD_LEGS) expect(contracts.isUnwindLeg(leg)).toBe(false);
  });
});

describe("the vocabularies and the database CHECK constraints", () => {
  /**
   * The last definition of each named CHECK across the migrations, in file order.
   *
   * "Last" rather than "first" because a constraint can be dropped and re-added: 0004 replaces
   * `execution_status_valid` to admit `signal`, `refunded` and `recovery_required`. Reading only
   * the initial schema would assert against a rule the database stopped enforcing.
   */
  async function checkedMembers(): Promise<Map<string, string[]>> {
    const dir = new URL("../../packages/database/migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    const found = new Map<string, string[]>();
    for (const file of files) {
      const sql = await readFile(new URL(file, dir), "utf8");
      // `prefix` is everything between `CHECK (` and the member list, e.g.
      // `"mandate_v2"."executions"."status" in `. Splitting it out is what separates a
      // membership constraint from `permission_has_signature`, which is a `not in` and is a
      // different rule entirely.
      const pattern = /CONSTRAINT "([a-z_]+)" CHECK \(([^()]*)\(([^()]*)\)/gi;
      for (const match of sql.matchAll(pattern)) {
        const [, name, prefix, list] = match;
        if (!name || !prefix || !list) continue;
        if (!/(?<!not) in $/i.test(prefix)) continue;
        found.set(
          name,
          [...list.matchAll(/'([^']*)'/g)].map((value) => value[1] as string),
        );
      }
    }
    return found;
  }

  test("each enum matches the constraint the database actually enforces", async () => {
    const checks = await checkedMembers();
    // If this map comes back empty the regex stopped matching, and every assertion below would
    // pass vacuously. Fail loudly instead.
    expect(checks.size).toBeGreaterThanOrEqual(5);
    const pairs: [string, readonly string[]][] = [
      ["execution_status_valid", contracts.EXECUTION_STATUSES],
      ["instance_status_valid", contracts.INSTANCE_STATUSES],
      ["instance_mode_valid", contracts.MODES],
      ["draft_mode_valid", contracts.MODES],
      ["permission_status_valid", contracts.PERMISSION_STATUSES],
      ["transaction_status_valid", contracts.TRANSACTION_STATUSES],
      ["transaction_leg_valid", contracts.TRANSACTION_LEGS],
    ];
    for (const [constraint, members] of pairs) {
      const enforced = checks.get(constraint);
      expect(enforced, constraint).toBeDefined();
      // Sorted: SQL order is the author's and the schema's order is the vocabulary's, and only
      // membership has to agree between the two.
      expect([...(enforced ?? [])].sort(), constraint).toEqual([...members].sort());
    }
  });

  test("`recovery_required` is in the enforced set, which is what 0004 widened it for", async () => {
    const checks = await checkedMembers();
    expect(checks.get("execution_status_valid")).toContain("recovery_required");
    expect(contracts.isExecutionStatus("recovery_required")).toBe(true);
    // The membership tests take a plain string, because the values they are handed come out of
    // `text` columns drizzle types as `string`. Casting to the union to call a narrower
    // signature is exactly the step that stops the compiler from helping.
    expect(contracts.isExecutionStatus("not-a-status")).toBe(false);
    expect(contracts.isInstanceStatus("armed")).toBe(true);
    expect(contracts.isTransactionLeg("done")).toBe(false);
  });
});

describe("the money and time bounds", () => {
  test("a decimal is never a number, and precision is bounded on both sides", () => {
    expect(accepts(schemas.decimalSchema, "100.000001")).toBe(true);
    expect(accepts(schemas.decimalSchema, 100.000001)).toBe(false);
    expect(accepts(schemas.usdcAmountSchema, "100.000001")).toBe(true);
    // Seven places is finer than USDC can settle at, and a value the chain cannot represent
    // must not reach a cap.
    expect(accepts(schemas.usdcAmountSchema, "100.0000001")).toBe(false);
    expect(accepts(schemas.usdcAmountSchema, "-1")).toBe(false);
    // The quote endpoint takes eighteen places because a sell is denominated in the base asset.
    expect(accepts(schemas.quoteAmountSchema, "1.000000000000000001")).toBe(true);
  });

  test("raw units are integers with no leading zeros", () => {
    expect(accepts(schemas.rawUnitsSchema, "10000000")).toBe(true);
    expect(accepts(schemas.rawUnitsSchema, "0")).toBe(true);
    // "0100" and "100" are the same number but not the same authorization: the worker compares
    // this string against units(...).toString() by exact equality before it will execute, and
    // the mismatch would surface as an opaque refusal after the user had signed.
    expect(accepts(schemas.rawUnitsSchema, "0100")).toBe(false);
    expect(accepts(schemas.rawUnitsSchema, "1.0")).toBe(false);
    expect(accepts(schemas.rawUnitsSchema, "-1")).toBe(false);
  });

  test("seconds are bounded by uint48, which is what the manager contract packs them into", () => {
    expect(accepts(schemas.unixSecondsSchema, contracts.MAX_UINT48)).toBe(true);
    // One past the bound encodes perfectly well in JSON and reverts onchain, which is the worst
    // place to find out: the user has already signed.
    expect(accepts(schemas.unixSecondsSchema, contracts.MAX_UINT48 + 1)).toBe(false);
    expect(contracts.MAX_UINT48).toBe(2 ** 48 - 1);
    expect(contracts.MAX_ALLOWANCE).toBe(2n ** 160n - 1n);
  });

  test("a timestamp accepts both a Date and an offset string and always emits a string", () => {
    const instant = new Date("2026-09-06T11:14:39.846Z");
    // Both forms are real: a server-side view hands a route `instance.createdAt` — a Date that
    // fastify serialises — while a client parsing that same response sees a string. One schema
    // that accepts both is what lets a single response schema describe the value on both sides.
    expect(schemas.timestampSchema.parse(instant)).toBe(instant.toISOString());
    expect(schemas.timestampSchema.parse(instant.toISOString())).toBe(instant.toISOString());
    // No offset is not an instant.
    expect(accepts(schemas.timestampSchema, "2026-09-06T11:14:39.846")).toBe(false);
    expect(accepts(schemas.nullableTimestampSchema, null)).toBe(true);
  });

  test("slippage is capped at the band the venue actually enforces", () => {
    expect(accepts(schemas.slippageBpsSchema, 500)).toBe(true);
    // Above 500 bps is not merely risky, it is unusable: packages/evm refuses any route more
    // than 5% from the Chainlink reference, so the order would never fill.
    expect(accepts(schemas.slippageBpsSchema, 501)).toBe(false);
    expect(accepts(schemas.slippageBpsSchema, 0)).toBe(false);
    expect(accepts(schemas.bpsSchema, 10_000)).toBe(true);
  });

  test("the equity scale is 8 and the quote scale is 6, and the two never swap", () => {
    expect(contracts.EQUITY_DECIMALS).toBe(8);
    expect(contracts.QUOTE_DECIMALS).toBe(6);
    expect(contracts.WEI_DECIMALS).toBe(18);
    // A buy spends USDC and receives the equity; a sell spends the equity and receives USDC.
    // Getting this backwards is a 10^2 error and assuming 18 is a 10^10 one.
    expect(contracts.inputDecimals("buy", contracts.EQUITY_DECIMALS)).toBe(6);
    expect(contracts.outputDecimals("buy", contracts.EQUITY_DECIMALS)).toBe(8);
    expect(contracts.inputDecimals("sell", contracts.EQUITY_DECIMALS)).toBe(8);
    expect(contracts.outputDecimals("sell", contracts.EQUITY_DECIMALS)).toBe(6);
    expect(contracts.denominations("buy")).toEqual({ input: "quote", output: "base" });
    expect(contracts.denominations("sell")).toEqual({ input: "base", output: "quote" });
  });

  test("the permission window boundaries match the manager and the repository", () => {
    const payload = { start: 1_000, end: 2_000 };
    expect(contracts.permissionWindow(payload, 999)).toBe("not_started");
    // `start` is inclusive and `end` is exclusive, matching the manager contract and matching
    // the repository, which treats `end * 1000 <= now` as expired.
    expect(contracts.permissionWindow(payload, 1_000)).toBe("open");
    expect(contracts.permissionWindow(payload, 1_999)).toBe("open");
    expect(contracts.permissionWindow(payload, 2_000)).toBe("expired");
  });
});

describe("the paging rule", () => {
  test("a cursor is both halves or neither", () => {
    expect(accepts(contracts.pageSchema, { limit: "50" })).toBe(true);
    expect(
      accepts(contracts.pageSchema, {
        before: "2026-09-06T11:14:39.846Z",
        before_id: "3f6b6e5a-9d3f-4e1a-8a4b-9f2c1d0e7a55",
      }),
    ).toBe(true);
    // Half a cursor would return the first page again, which an infinite scroll reads either as
    // "no more rows" or as a loop, depending on the client.
    expect(
      accepts(contracts.pageSchema, { before_id: "3f6b6e5a-9d3f-4e1a-8a4b-9f2c1d0e7a55" }),
    ).toBe(false);
    // The ceiling bounds one page's cost; a caller cannot ask for the whole table at once.
    expect(accepts(contracts.pageSchema, { limit: "101" })).toBe(false);
    expect(accepts(contracts.pageSchema, { limit: "0" })).toBe(false);
    expect(contracts.pageSchema.parse({}).limit).toBe(50);
  });
});
