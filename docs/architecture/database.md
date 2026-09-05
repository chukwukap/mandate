# Database model

The Drizzle schema is defined in [schema/index.ts](../../packages/database/src/schema/index.ts).
Application tables live in `mandate_v2`; migration bookkeeping lives in
`mandate_migrations`. Timestamps use millisecond precision to preserve signed
commitments across JSON and PostgreSQL round trips.

| Table | Purpose |
| --- | --- |
| `users` | Stable application UUID mapped to a unique verified Privy DID. |
| `drafts` | Account-bound immutable plan, envelope, rendered review, signing message and expiry. |
| `instances` | Consumed draft, signature, mode, status, runtime, schedule and eligibility attestation. |
| `permissions` | Immutable account/spender/token payload, hash, signature and observed lifecycle status. |
| `evaluations` | Inputs, outcome, refusals, admitted count and notification records from a tick. |
| `executions` | Immutable order intent and mutable pipeline status, stage, reason and transaction hash. |
| `transactions` | Signed bytes, hash, signer, nonce, leg and expected transfer evidence. |
| `worker_state` | Global leader generation, heartbeat and execution-availability flag. |

## Ownership and invariants

All six tenant tables (`drafts`, `instances`, `permissions`, `evaluations`,
`executions`, `transactions`) force row-level security. The transaction-local
`mandate.user_id` setting selects the owner. Missing tenant context reveals no tenant
rows. Composite foreign keys prevent attaching child records to another owner's
instance or execution.

`users` supports identity lookup before tenant context exists. `worker_state` is
process coordination metadata. Neither uses the tenant policy. This isolation model
protects application queries; it is not a boundary against a compromised database
credential that can set an arbitrary tenant context.

A draft can be consumed once. Database triggers protect signed draft content,
instance identity/signature, prepared permission payloads, admitted intent fields,
and signed transaction content. Journal deletion is prohibited. The journal is
unique by execution/leg and by signer/nonce, and transaction hashes are unique.

Runtime updates, evaluations and admitted intents commit together. The worker
commits a signed journal entry before broadcasting. Changing an execution status
manually does not change onchain settlement and must not be used as a substitute
for receipt evidence.

## Migrations and access

Run `bun run db:migrate` with `MIGRATION_DATABASE_URL` set to the migration owner.
The API and worker use restricted, non-superuser, non-BYPASSRLS credentials.
Readiness rejects roles that bypass row-level security. Grant required access after
migrations, including newly added tables; see [local setup](../runbooks/api-local.md).

After changing the Drizzle schema, generate and review SQL with `bun run db:generate`.
Custom trigger migrations also belong in the versioned migration history. Review
foreign-key/unique-constraint ordering and run the native PostgreSQL checks before
using a migration against persistent data. Do not edit an already applied migration;
add a new one.

The Rust database is not imported. Existing IDs, signatures and sessions must not
be copied into `mandate_v2` as if they were compatible. See [rewrite scope](../migration/README.md).
