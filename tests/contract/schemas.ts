import { z } from "zod";
import {
  addressSchema,
  decimalSchema,
  digestSchema,
  executionStatusSchema,
  idSchema,
  modeSchema,
  nullableTimestampSchema,
  rawUnitsSchema,
  statusSchema,
  symbolSchema,
  timestampSchema,
  unixSecondsSchema,
  usdcAmountSchema,
} from "../../packages/contracts/src/schemas/primitives.js";

/**
 * The public wire contract, written once, out of the shared leaf rules.
 *
 * Every leaf below is imported from `packages/contracts/src/schemas/primitives.ts` rather than
 * respelled here. That is the whole point: an address is `addressSchema`, a money field is
 * `usdcAmountSchema` or `decimalSchema`, a raw amount is `rawUnitsSchema`, an instant is
 * `timestampSchema`. If a route starts emitting a price with 78 significant digits, or an
 * amount as a JSON number, or a status this build does not know, the failure lands here — in a
 * test named after the field — instead of in apps/web as an empty panel with nothing to blame.
 *
 * Objects are deliberately NOT `strictObject`, with three named exceptions below. zod's default
 * object strips unknown keys instead of rejecting them, which is exactly the contract semantics
 * wanted: adding a field is additive and must keep passing (GET /v1/market says so in as many
 * words), while removing or renaming one is breaking and fails. The exceptions are the three
 * bodies where an extra key is itself the bug — see `problemSchema`, `readySchema` and
 * `journalEntrySchema`.
 *
 * `packages/contracts/src/index.ts` is not the import path used here on purpose: it re-declares
 * `addressSchema`, `signatureSchema`, `idSchema`, `modeSchema` and `statusSchema` locally and
 * does not re-export the `schemas/` module at all, so the rules the routes import and the rules
 * `types/` infers from are two separate declarations today. `primitives.test.ts` pins them
 * against each other; everything else in this directory validates against the `schemas/` copy,
 * which is the one the shared types are built on.
 */

/* ------------------------------------------------------------------ leaf helpers */

/** Fraction digits in a decimal string. `"320"` is 0, `"320.220106"` is 6. */
export function fractionDigits(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

/**
 * A published price: a non-negative decimal at USDC precision, six places or fewer.
 *
 * This is `usdcAmountSchema`, unchanged. Named separately because the thing it catches is not
 * an amount of USDC — it is the unrounded quotient. `Money` carries 78 significant digits so a
 * division never rounds mid-calculation, and a published figure that inherits that emits
 * "321.32767453876625596705491618488937330820979355339566233345586628655744953227" — a value no
 * pool can settle at, which any consumer parsing it as a float silently truncates anyway. Both
 * `impliedPrice` in the market catalogue and `assetMarket` in packages/evm quantise for exactly
 * this reason, and both say so in a comment; this schema is what stops the next producer from
 * skipping it.
 */
export const priceSchema = usdcAmountSchema;

/**
 * A signed basis-point measurement, always two decimal places.
 *
 * `"-0.00"` is refused rather than tolerated. It is what a float64 prints for a deviation of
 * -0.004 bps, and to a user it reads as a loss that did not happen; every producer normalises
 * negative zero away before formatting, and this is the assertion that keeps them doing it.
 */
export const bpsStringSchema = z
  .string()
  .regex(/^-?\d{1,40}\.\d{2}$/)
  .refine((value) => value !== "-0.00", "negative zero must be normalised away");

/** A 32-byte transaction hash, `0x` prefixed. Distinct from `digestSchema`, which has no prefix. */
export const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** A basescan link, or null when there is no hash to link to. Never a bare hash. */
export const explorerUrlSchema = z
  .string()
  .regex(/^https:\/\/basescan\.org\/tx\/0x[0-9a-fA-F]{64}$/)
  .nullable();

/** A keyset cursor. Both halves or neither — a timestamp alone is not a key. */
export const cursorSchema = z.object({ before: timestampSchema, before_id: idSchema }).nullable();

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_page: cursorSchema });
}

/* ------------------------------------------------------------------ problem body */

/**
 * RFC7807, exactly six keys.
 *
 * Strict, and that is the security property rather than tidiness: `setErrorHandler` is the one
 * place every thrown error in the process converges, including SDK errors whose message and
 * body can carry a bearer token or an RPC URL with a provider key embedded. The handler
 * constructs this object field by field and never spreads the caught error; a seventh key
 * appearing here means something started leaking, and it must fail.
 *
 * `status` and not `statusCode`: `Problem` carries `status`, apps/web reads `status`, and a
 * handler that emitted fastify's own `statusCode` name instead would be a silent rename.
 */
export const problemSchema = z.strictObject({
  type: z.string().regex(/^urn:mandate:problem:[a-z0-9-]+$/),
  title: z.string().min(1),
  status: z.int().min(400).max(599),
  code: z.string().regex(/^[a-z0-9-]+$/),
  detail: z.string().min(1),
  request_id: z.string().min(1),
});

/* ------------------------------------------------------------------ health */

/**
 * Strict. The comment on the route says the body is pinned to exactly these four keys because
 * it is public and unauthenticated, so every field added is a field an unauthorised caller can
 * fingerprint the deployment with. Diagnostics belong in logs.
 */
export const readySchema = z.strictObject({
  status: z.enum(["ready", "unavailable"]),
  database: z.boolean(),
  chain: z.boolean(),
  execution_available: z.boolean(),
});

export const healthSchema = z.strictObject({ status: z.literal("ok") });

/* ------------------------------------------------------------------ identity */

export const meSchema = z.object({
  user: idSchema,
  privy_did: z.string().min(1),
  wallets: z.array(addressSchema),
  wallet: addressSchema.nullable(),
  wallet_state: z.enum(["resolved", "selection_required", "none_linked", "not_linked"]),
  wallet_selection_required: z.boolean(),
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  eligible: z.boolean(),
  eligibility_reason: z
    .enum(["region_unknown", "region_restricted", "region_unsupported"])
    .nullable(),
  chain_id: z.literal(8453),
  automation: z.object({
    supported: z.boolean(),
    signer_id: z.string().nullable(),
    wallet: addressSchema.nullable(),
    delegated: z.boolean(),
  }),
  execution_available: z.boolean(),
  server_time: timestampSchema,
});

export const walletCapabilitySchema = z.object({
  address: addressSchema,
  embedded: z.boolean(),
  delegated: z.boolean(),
});

export const walletsSchema = z.object({
  items: z.array(walletCapabilitySchema),
  chain_id: z.literal(8453),
  signer_id: z.string().nullable(),
});

/* ------------------------------------------------------------------ market */

/**
 * A catalogue asset.
 *
 * `decimals` is a literal 8, not `z.int()`. Every Coinbase B20 equity on Base has 8 decimals and
 * nothing in this market has 18; a catalogue entry that ever reported something else would
 * misprice an order by 1e10, and a schema that merely said "an integer" would let it through.
 */
export const assetSchema = z.object({
  symbol: symbolSchema,
  token: addressSchema,
  feed: addressSchema,
  decimals: z.literal(8),
});

/**
 * One reading in the `feeds` array.
 *
 * `value` is `decimalSchema`, whose 28-place bound is the authored-constant rule. That holds for
 * every `oracle:` reading, which is a Chainlink answer at 8 decimals. It does NOT hold for a
 * `dex:` reading under every reader: the shipped `BaseReader.assetMarket` quantises the venue
 * price to USDC precision before publishing it, but the recorded fixture client in
 * tests/fixtures/chain still emits the raw 10/amount_out quotient at the full 78-digit `Money`
 * precision. `marketFeedSchema` therefore takes the value rule as an argument so a caller says
 * which bound it means, and `market.test.ts` asserts the tighter one where the API itself owns
 * the number.
 */
export function marketFeedSchema(value: z.ZodString = decimalSchema) {
  return z.object({
    uri: z.string().regex(/^(oracle|dex):[A-Za-z0-9]{1,24}$/),
    value: value.nullable(),
    /** Chainlink round timestamp in Unix seconds. 0 when the reading is absent. */
    updated_at: unixSecondsSchema,
    stale: z.boolean(),
  });
}

export const catalogueQuoteSchema = z.object({
  /** USDC per whole share implied by the probe. */
  price: priceSchema,
  amount_in: rawUnitsSchema,
  amount_out: rawUnitsSchema,
  min_out: rawUnitsSchema,
  tick_spacing: z.int().positive(),
  expires_at: timestampSchema,
});

/** Every reason an asset can be listed but not traded. Closed, and the API must not invent one. */
export const marketBlockerSchema = z.enum([
  "reference-unavailable",
  "reference-stale",
  "no-priced-route",
  "quote-deviation",
  "chain-unavailable",
]);

/**
 * A catalogue row.
 *
 * The refinement is the invariant that has bitten: an asset that cannot be traded is still
 * returned, and it carries BOTH a machine-readable `reason` and a sentence a UI can show. A
 * silently missing symbol is indistinguishable from a symbol that was never configured, and a
 * `reason` with no `detail` sends the reader to look at the wrong subsystem — which is exactly
 * what happened when MSFTc and AMZNc were reported as reference-stale while the truth was that
 * neither has an Aerodrome route inside the deviation band.
 */
export const catalogueEntrySchema = z
  .object({
    symbol: symbolSchema,
    token: addressSchema,
    feed: addressSchema,
    decimals: z.literal(8),
    nav: decimalSchema.nullable(),
    nav_source: z.enum(["quote", "oracle"]).nullable(),
    nav_updated_at: unixSecondsSchema,
    nav_stale: z.boolean(),
    quote: catalogueQuoteSchema.nullable(),
    deviation_bps: bpsStringSchema.nullable(),
    tradable: z.boolean(),
    reason: marketBlockerSchema.nullable(),
    detail: z.string().min(1).nullable(),
  })
  .refine(
    (entry) => (entry.tradable ? entry.reason === null : entry.reason !== null),
    "a blocked entry must name its reason and a tradable one must not",
  )
  .refine(
    (entry) => (entry.reason === null) === (entry.detail === null),
    "reason and detail travel together; a code with no sentence is not showable",
  );

export const probeTermsSchema = z.object({
  side: z.enum(["buy", "sell"]),
  amount: decimalSchema,
  slippage_bps: z.int().min(1).max(500),
  deviation_limit_bps: z.literal(500),
  note: z.string().min(1),
});

export function marketSchema(feedValue: z.ZodString = decimalSchema) {
  return z.object({
    chain_id: z.literal(8453),
    assets: z.array(assetSchema),
    feeds: z.array(marketFeedSchema(feedValue)),
    execution_available: z.boolean(),
    reference_notice: z.string().min(1),
    as_of: timestampSchema,
    probe: probeTermsSchema,
    catalogue: z.array(catalogueEntrySchema),
  });
}

export const quoteSchema = z.object({
  token_in: addressSchema,
  token_out: addressSchema,
  amount_in: rawUnitsSchema,
  amount_out: rawUnitsSchema,
  min_out: rawUnitsSchema,
  tick_spacing: z.int().positive(),
  expires_at: timestampSchema,
  /** The Chainlink reading the route was admitted against, not the venue's own number. */
  reference: decimalSchema,
  symbol: symbolSchema,
  decimals: z.literal(8),
  price: priceSchema,
  deviation_bps: bpsStringSchema,
});

/* ------------------------------------------------------------------ instances */

/**
 * The summary object every list row and every lifecycle response returns.
 *
 * Two names do not match their column and both are load-bearing: `strategy` is the draft id —
 * the signed artifact the instance runs, not the instance id — and `spent` is spend-to-date
 * against `lifetime`, the signed cap. Renaming either silently blanks the budget meter in
 * apps/web rather than erroring anywhere.
 */
export const instanceSchema = z.object({
  id: idSchema,
  strategy: idSchema,
  name: z.string().min(1),
  mode: modeSchema,
  requested_mode: modeSchema,
  status: statusSchema,
  halt_reason: z.string().min(1).nullable(),
  last_tick_at: nullableTimestampSchema,
  next_tick_at: nullableTimestampSchema,
  spent: decimalSchema,
  lifetime: decimalSchema,
  orders: z.int().min(0),
  created_at: timestampSchema,
  execution_available: z.boolean(),
  eligibility_expires_at: nullableTimestampSchema,
});

/**
 * The summary plus the signed authority itself, returned verbatim from the draft row so a
 * client can re-display — or re-hash — exactly what was authorized. Nothing here is recomputed:
 * a rebuilt render would hash differently from the one the signature covers.
 */
export const instanceDetailSchema = instanceSchema.extend({
  account: addressSchema,
  plan: z.object({ nodes: z.array(z.unknown()), machines: z.array(z.unknown()) }),
  envelope: z.object({
    version: z.literal("mandate/2"),
    caps: z.object({
      lifetime: decimalSchema,
      per_order: decimalSchema,
      per_period: decimalSchema,
      period_secs: z.int().positive(),
      expires_at: timestampSchema,
      slippage_bps: z.int().min(1).max(500),
    }),
    assets: z.array(assetSchema),
    quote: addressSchema,
    venue: z.literal("aerodrome"),
  }),
  render_text: z.string().min(1),
  render_sha256: digestSchema,
});

export const draftSchema = z.object({
  artifact_id: digestSchema,
  plan: z.object({ nodes: z.array(z.unknown()), machines: z.array(z.unknown()) }),
  envelope: z.object({ version: z.literal("mandate/2") }),
  name: z.string().min(1),
  reading: z.string().min(1),
  render_text: z.string().min(1),
  render_sha256: digestSchema,
  confirm_message: z.string().min(1),
  expires_at: timestampSchema,
  execution_available: z.boolean(),
});

export const createdInstanceSchema = z.object({
  strategy: idSchema,
  version: digestSchema,
  instance: idSchema,
  status: statusSchema,
  mode: modeSchema,
  needs_automation: z.boolean(),
  execution_available: z.boolean(),
});

/** An evaluation row, returned as stored. apps/web reads these camelCase keys off it directly. */
export const evaluationSchema = z.object({
  id: idSchema,
  userId: idSchema,
  instanceId: idSchema,
  at: timestampSchema,
  outcome: z.string().min(1),
  admitted: z.int().min(0),
  refused: z.string().nullable(),
  inputs: z.record(z.string(), decimalSchema),
  notifications: z.array(z.unknown()),
});

/* ------------------------------------------------------------------ executions */

/**
 * An amount of one token in both representations at once.
 *
 * `raw` is the durable value and is always present; `amount` is the rendering and is null when
 * the scale is unknown. `decimals` is nullable and that nullability is load-bearing — an
 * address belonging to neither USDC nor this strategy's signed assets has no scale we are
 * entitled to guess, and defaulting to 18 renders a 1 AAPLc position as 0.00000001.
 */
export const tokenAmountSchema = z.object({
  token: addressSchema,
  symbol: z.string().min(1).nullable(),
  decimals: z.int().min(0).max(36).nullable(),
  raw: z.string().regex(/^[0-9]+$/),
  amount: decimalSchema.nullable(),
});

export const reasonSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9-]+$/),
    message: z.string().min(1),
    /** The worker's own string, always carried alongside the translation. */
    raw: z.string().min(1),
  })
  .nullable();

export const executionListItemSchema = z.object({
  id: idSchema,
  instance: idSchema,
  strategy_name: z.string().nullable(),
  status: executionStatusSchema,
  stage: z.enum(["fund", "approve", "swap", "reset", "refund", "done"]),
  outcome: z.enum([
    "signal",
    "queued",
    "in_flight",
    "filled",
    "reverted",
    "cancelled",
    "refunded",
    "needs_review",
  ]),
  headline: z.string().min(1),
  what_happened: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  symbol: z.string().min(1).nullable(),
  spent: tokenAmountSchema,
  intended_amount: decimalSchema.nullable(),
  tx_hash: txHashSchema.nullable(),
  explorer_url: explorerUrlSchema,
  reason: reasonSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  // The compatibility block apps/web's `Execution` type still reads. Same values as the
  // snake_case fields above; deleting one of these is a breaking change until apps/web moves.
  instanceId: idSchema,
  amountIn: rawUnitsSchema,
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  txHash: txHashSchema.nullable(),
  createdAt: timestampSchema,
  intent: z.unknown(),
});

/**
 * One journal row. Strict, because `journalEntry` is an explicit allowlist and not a spread
 * with deletions: the `transactions` table carries `raw_transaction` — signed, possibly
 * un-broadcast bytes, already in pino's redact list — and `user_id`. A column added to that
 * table must never reach an HTTP response because someone forgot to extend a blocklist.
 */
export const journalEntrySchema = z.strictObject({
  leg: z.enum(["fund", "approve", "swap", "reset", "refund"]),
  status: z.enum(["signed", "confirmed", "reverted"]),
  hash: txHashSchema,
  explorer_url: explorerUrlSchema,
  signer: addressSchema,
  nonce: z.int().min(0),
  submitted_at: timestampSchema,
  confirmed_at: timestampSchema.nullable(),
  expectation: z
    .object({
      /** "guaranteed_minimum" on the swap leg: the slippage floor, never a claimed fill. */
      kind: z.enum(["guaranteed_minimum", "transfer"]),
      amount: tokenAmountSchema,
      recipient: addressSchema,
      from: addressSchema.nullable(),
    })
    .nullable(),
  settlement: z
    .object({
      status: z.enum(["confirmed", "reverted"]),
      block_number: rawUnitsSchema,
      confirmations: z.int().min(0),
      gas_used: rawUnitsSchema,
      effective_gas_price_wei: rawUnitsSchema,
      gas: z.object({
        l2_wei: rawUnitsSchema,
        l1_wei: rawUnitsSchema,
        fee_wei: rawUnitsSchema,
        fee_eth: decimalSchema,
      }),
      received: rawUnitsSchema.nullable(),
    })
    .nullable(),
});

export const executionDetailSchema = executionListItemSchema.extend({
  account: addressSchema,
  fill: z.object({
    state: z.enum(["verified", "unverified", "not_applicable"]),
    reason: z.string().min(1),
    guaranteed_minimum: tokenAmountSchema.nullable(),
    received: tokenAmountSchema.nullable(),
    price: z.object({
      basis: z.literal("guaranteed_minimum"),
      quote_symbol: z.string().min(1).nullable(),
      base_symbol: z.string().min(1).nullable(),
      guaranteed_price: priceSchema.nullable(),
      filled_price: priceSchema.nullable(),
      difference_bps: bpsStringSchema.nullable(),
      direction: z.enum(["favourable", "adverse", "at_limit"]).nullable(),
    }),
  }),
  cost: z
    .object({
      input: tokenAmountSchema,
      gas: z.object({
        complete: z.boolean(),
        legs: z.int().min(0),
        paid_by: addressSchema.nullable(),
        /** Direct execution pays gas from the signing wallet. */
        borne_by: z.literal("wallet"),
        note: z.string().min(1),
        l2_wei: rawUnitsSchema,
        l1_wei: rawUnitsSchema,
        fee_wei: rawUnitsSchema,
        fee_eth: decimalSchema,
      }),
    })
    .nullable(),
  decision: z
    .object({
      at: timestampSchema,
      outcome: reasonSchema,
      admitted: z.int().min(0),
      inputs: z.record(z.string(), decimalSchema),
      refusals: z.array(reasonSchema),
      notifications: z.array(z.unknown()),
    })
    .nullable(),
  journal: z.array(journalEntrySchema),
});

const tallySchema = z.object({
  code: z.string().regex(/^[a-z0-9-]+$/),
  message: z.string().min(1),
  ticks: z.int().min(0),
});

export const summarySchema = z.object({
  instance: idSchema,
  name: z.string().min(1),
  status: statusSchema,
  mode: modeSchema,
  orders: z.object({
    total: z.int().min(0),
    by_outcome: z.record(z.string(), z.int().min(0)),
    by_status: z.array(
      z.object({
        status: executionStatusSchema,
        outcome: z.string().min(1),
        orders: z.int().min(0),
        usdc_in: usdcAmountSchema,
      }),
    ),
    first_at: timestampSchema.nullable(),
    last_at: timestampSchema.nullable(),
  }),
  spend: z.object({
    currency: z.literal("USDC"),
    decimals: z.literal(6),
    admitted: usdcAmountSchema,
    settled: usdcAmountSchema,
    returned: usdcAmountSchema,
    in_flight: usdcAmountSchema,
    signalled: usdcAmountSchema,
    not_executed: usdcAmountSchema,
    lifetime_cap: decimalSchema,
    remaining: usdcAmountSchema,
    per_period_cap: decimalSchema,
    period_spent: decimalSchema,
    cap_notice: z.string().min(1),
  }),
  refusals: z.object({
    window: z.object({
      since: timestampSchema,
      until: timestampSchema,
      secs: z.int().positive(),
      note: z.string().min(1),
    }),
    ticks: z.int().min(0),
    admitted_orders: z.int().min(0),
    outcomes: z.array(tallySchema),
    reasons: z.array(tallySchema),
    truncated: z.boolean(),
  }),
});

/* ------------------------------------------------------------------ assertions */

/**
 * Parse and return the typed value, or fail with the field path rather than "expected true".
 *
 * `expect(schema.safeParse(body).success).toBe(true)` is the tempting shape and it is nearly
 * useless when it fails: the reason a contract test exists is to name the field that moved.
 */
export function parsed<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`response does not match the contract\n  ${issues}`);
  }
  return result.data;
}
