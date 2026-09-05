# Worker setup and recovery

The worker runs on Node.js and shares the API's PostgreSQL database. Bun installs,
builds and tests the workspace. Migrations are explicit; startup never changes the
schema. The web workspace has its own [setup guide](../../apps/web/README.md). For every environment setting, see the
[configuration reference](../reference/configuration.md).

## Start locally

From `mandate-node/`:

```sh
bun install --frozen-lockfile
cp .env.worker.example .env.worker
# Set DATABASE_URL and APP_ORIGIN to the API's database and signed origin.
# Apply migrations using the migration-owner credentials in .env.
bun run db:migrate
bun run build:worker
bun run start:worker
```

The example names a `mandate_worker` database role. Either create that restricted
role and grant it access using the pattern in [API setup](api-local.md), or set
`DATABASE_URL` to your existing restricted application role. The database must
already exist; the migration command creates schemas and tables, not a database.

`bun run dev:worker` uses Node with tsx and watch mode. `WORKER_EXECUTE=0` is
the default: manual strategies record signals, automatic strategies preserve their
runtime without signing. An outstanding automatic execution blocks further
admission until an execution-enabled worker reconciles it. A second process waits
for the PostgreSQL session advisory lock. Use a direct PostgreSQL connection or a
session-mode pooler; transaction-mode pooling cannot hold this leadership lock.

The worker has no HTTP listener and requires no Privy credentials. It verifies the
wallet signature and persisted review independently. API authentication stays with
Privy. Each eligible API arm request records a country attestation valid for 24
hours. Automatic strategies pause when this expires; an eligible arm request
renews it. This is a bounded prior observation, not continuous location tracking.

## Execution configuration

Live execution requires all of `WORKER_EXECUTE=1`, a worker-only private key,
the matching public `SPENDER_ADDRESS`, and an explicit `ELIGIBLE_COUNTRIES`
allowlist matching the API. Use one dedicated signer for this database, with ETH
for gas. Do not share it with another service, database or wallet operator. Supply
secrets through the worker environment; never copy them into the API or web app.

Only automatic **USDC-funded buys** are implemented. The account must have an
active Coinbase SpendPermissionManager permission for the exact spender, token,
allowance, period and expiry. An ordinary Privy EOA is not assumed to support that
permission. Manual sell signals do not submit trades; automatic sells remain
unsupported until corresponding account authority is implemented.

The worker checks the signed artifact, current rule condition, active permission,
remaining onchain allowance, account balances, recipient policy, token transfer
pause, oracle pause, quote and transaction simulation. New funding expires 60
seconds after intent admission. Swap output is paid directly to the account.

Execution is deliberately limited to Monday–Friday **09:35–15:55 America/New_York**
and oracle observations at most five minutes old. This is a conservative execution
window, not a complete exchange calendar or 24/7 support. Holiday and early-close
feeds normally fail freshness, but no independent holiday/session provider is
integrated. Valid feeds with longer heartbeats will also be rejected. Add an
authoritative session feed before expanding this window; do not loosen freshness
to make old closing prices tradeable. Token policy simulation remains mandatory.

Quotes last 20 seconds. Public RPCs may rate-limit or be too slow for a multi-leg
trade; configure an RPC with sufficient capacity. Oracle/DEX data unavailability
records a failed observation without substituting zero or consuming an edge.

## Durable execution

One leader processes one automatic order at a time across owners. SQL reads are
tenant-scoped; the worker role must not be superuser or BYPASSRLS. Scheduling pages
are bounded, but scanning for outstanding work remains proportional to the number
of owners. This initial design favors correctness over high throughput.

Each evaluation, runtime transition and order intent commits atomically. Budget
counters reserve the admitted amount, including manual signals and orders later
cancelled or refunded. Reservations are not automatically credited back; the API's
legacy `spent` field is this conservative counter, not settled onchain volume.
Equity sizing uses USDC plus the signed strategy's allowlisted stock positions.

The journal stores immutable signed bytes, hash, signer, nonce and receipt evidence
**before** broadcast. A restart resends the same bytes. Funding, exact router
approval and swap are separate transactions. A failed funded trade clears router
allowance and returns exactly that order's funded USDC. It never sweeps the signer
balance. Fees are paid by the signer and are not refunded to it by users.

Receipts require the configured confirmations, canonical block hashes and expected
transfer evidence. Previously settled legs are checked again before progressing.
These are confirmation-based checks, not a guarantee against deep reorganizations
after an order has finished. There is no automatic fee replacement.

Pause/kill prevents newly prepared funding. Already journaled transactions may
still broadcast or settle; onchain permission revocation is the authority stop.
Stopping the process preserves the journal but delays any refund in progress.

## Inspect and recover

The API reports `execution_available` from a live, execution-enabled leader
heartbeat (30-second freshness). A recovery-required order makes it false. This
does not promise a particular strategy is armed, eligible or trading. Observe
the worker's structured logs and each instance's evaluation/execution history.

Inspect journal metadata without printing raw transactions or secrets:

```sh
bun run worker:inspect USER_UUID EXECUTION_UUID
```

An ambiguous receipt, consumed unknown nonce, changed settled receipt, insufficient
funded balance or failed refund moves the order to `recovery_required` and halts
its strategy. This deliberately blocks new automatic work globally. Never delete
the journal, reset a funding leg, reuse a nonce or restart from `spend`.

Keep the worker stopped while reviewing an unresolved order. Verify every journal
hash, receipt, canonical block, spender nonce, approval and account transfer on
Base. Preserve a database backup and the evidence. A pending transaction can still
mine; timeout is not proof of failure. Recovery from ambiguous external signer use
or a deep reorganization requires operator reconciliation, not a blind retry.
The shipped inspector is read-only; there is no blanket force-retry command.

## Verification

```sh
bun run lint
bun run typecheck
bun run test:worker
bun run test:api
PG_BIN=/path/to/postgresql/bin python3 scripts/dev/test-postgres.py
```

The native script creates and removes a temporary cluster, runs tests under a
restricted database role and checks built Node process startup/shutdown against a
local RPC fixture. Tests never send a mainnet transaction. See the
[worker verification record](../architecture/worker-verification.md).
