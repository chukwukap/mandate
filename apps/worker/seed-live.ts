/**
 * Put a strategy the API never accepted in front of the live worker, and watch it refuse.
 *
 * Written as a direct row insert on purpose, which the contract harness deliberately avoids:
 * this is not a fixture for other assertions to trust, it is the one thing the test suite cannot
 * express — a row that reached the database by a path other than an authenticated request with a
 * valid signature. The worker should decline it, and should say why in terms an operator can act
 * on rather than filing it under a market outage.
 *
 * The envelope here is DELIBERATELY well-formed: version, venue, quote and a caps object that
 * satisfies capsSchema, with assets copied from the catalogue so `canonical()` matches. An
 * earlier draft of this file got the caps field names wrong (`period_seconds` for `period_secs`,
 * and `expires_at` outside `caps`), which meant verifyCommitment threw at its very first check
 * and the signature was never reached — the run looked like it proved the signature boundary
 * when it had only proved the schema one. Only the signature is forged now, so the refusal is
 * attributable to the thing being tested.
 *
 * Execution is off in .env.worker, so nothing is signed or broadcast either way.
 *
 * Expected: an evaluation row with outcome `invalid-commitment`, an error line naming the
 * instance, and an exponentially backing-off next_tick_at rather than a retry every 30 seconds.
 */
import { randomUUID } from "node:crypto";
import { connectDatabase } from "@mandate/database";
import { ASSETS, USDC } from "@mandate/evm";
import { initialRuntime, review } from "@mandate/strategy";
import { sql } from "drizzle-orm";

const url =
  process.env.DATABASE_URL ?? "postgresql://mandate:mandate@127.0.0.1:5432/mandate_probe";
const { db, close } = connectDatabase(url);

const asset = ASSETS.find((a) => a.symbol === "AAPLc");
if (!asset) throw new Error("AAPLc is missing from the catalogue");

// Chosen to be TRUE against the live market, so the tick reaches a decision rather than stopping
// at "condition not met" — the decision is the part worth watching.
const plan = {
  params: [],
  nodes: [
    {
      id: "cheap",
      op: "lt",
      args: [
        { kind: "feed", feed: `oracle:${asset.symbol}` },
        { kind: "const", value: "100000" },
      ],
    },
  ],
  machines: [
    {
      id: "buy",
      scope: "portfolio",
      initial: "watch",
      states: [
        {
          id: "watch",
          transitions: [
            {
              when: "cheap",
              fires: "on_edge",
              to: "watch",
              actions: [
                { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const expiresAt = new Date(Date.now() + 86_400_000);

// Field names and nesting match capsSchema exactly; it is a strictObject, so an extra or
// misspelled key is a hard parse failure rather than a silently ignored one.
const envelope = {
  version: "mandate/2",
  caps: {
    lifetime: "100",
    per_order: "10",
    per_period: "50",
    period_secs: 86_400,
    max_orders_per_period: 10,
    cooldown_secs: 0,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    slippage_bps: 50,
  },
  // Straight from the catalogue: verifyCommitment compares canonical(known) against
  // canonical(asset), so a hand-typed address or a missing `feed` fails on the asset check
  // instead of on the signature.
  assets: [asset],
  quote: USDC,
  venue: "aerodrome",
};

const rendered = review(plan as never, envelope as never);

const now = new Date();
const userId = randomUUID();
const draftId = randomUUID();
const instanceId = randomUUID();
const account = "0x1111111111111111111111111111111111111111";

await db.execute(sql`
  insert into mandate_v2.users (id, privy_did, created_at)
  values (${userId}, ${`did:privy:seed${Date.now()}`}, ${now})
`);

await db.execute(sql`
  insert into mandate_v2.drafts
    (id, user_id, artifact_id, name, mode, plan, envelope, reading, render_text, render_hash,
     confirm_message, created_at, expires_at, consumed_at, account)
  values (${draftId}, ${userId}, ${`seed-${Date.now()}`}, 'Live worker probe', 'manual',
     ${JSON.stringify(plan)}::jsonb, ${JSON.stringify(envelope)}::jsonb,
     ${rendered.render_text}, ${rendered.render_text}, ${rendered.render_sha256},
     'seed', ${now}, ${expiresAt}, ${now}, ${account})
`);

const runtime = initialRuntime(plan as never, now.getTime());

await db.execute(sql`
  insert into mandate_v2.instances
    (id, user_id, draft_id, name, mode, status, signature, runtime, tick_interval_ms,
     created_at, updated_at, next_tick_at)
  values (${instanceId}, ${userId}, ${draftId}, 'Live worker probe', 'manual', 'armed',
     ${`0x${"11".repeat(65)}`}, ${JSON.stringify(runtime)}::jsonb, 12000,
     ${now}, ${now}, ${now})
`);

console.log(`seeded armed instance ${instanceId} with a forged signature`);
console.log(`  user     ${userId}`);
console.log(`  expect   outcome "invalid-commitment", logged, and a backing-off next_tick_at`);
await close();
