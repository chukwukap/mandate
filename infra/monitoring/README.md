# Monitoring

Prometheus scrape configuration, alert rules, an exporter and a Grafana dashboard for a system
that moves other people's money.

The operating principle for everything in this directory: **an alert nobody knows how to action
is noise, and a threshold nobody can defend gets tuned away the first time it is inconvenient.**
So every alert below has a `derivation` annotation naming the constant, measurement or
operational bound its threshold came from, and a section here saying what to DO. If you find
yourself wanting to widen a number to stop an alert, read its derivation first — several of
them exist to stop exactly that.

## What scrapes what

| Job | Source | Covers |
|---|---|---|
| `mandate-postgres` | [`burningalchemist/sql_exporter`](https://github.com/burningalchemist/sql_exporter) over `infra/postgres/04-metrics.sql` | orders, the signed transaction journal, schedule lag, spend permissions, worker heartbeat |
| `mandate-market` | `infra/monitoring/exporter` (in this directory) | Chainlink round ages, which assets route, quote deviation, API readiness and error rate |
| `mandate-blackbox` | `blackbox_exporter` | one signal: can anything reach the API over HTTP |

Three sources rather than one, and deliberately not sharing code. When the market exporter dies
it takes its own alerts with it, so the reachability signal has to come from a process that has
nothing to do with it. `MandateMonitoringTargetDown` is what makes the rest of the file
trustworthy — without it a dead exporter is indistinguishable from a healthy system.

### Why a bespoke exporter

The database knows what the worker decided, not what the worker read. Chainlink round age — the
one input that decides whether anything can be priced at all — has exactly one observable source
outside the chain: `GET /v1/market`, the only unauthenticated `/v1` route.

`prometheus-community/json_exporter` was the obvious zero-code alternative. It was rejected
because `deviation_bps` crosses the wire as a decimal string and jsonpath cannot convert it, the
blocker reason is an enum that has to be one-hot encoded to stay queryable, and a jsonpath
expression cannot be unit-tested against a fixture in this repository. The mapping is the part
most likely to be silently wrong, so it is the part with tests.

### Why not `postgres_exporter`

Its default collectors read `pg_stat_*`, `pg_settings` and the table catalogue, and the scrape
role deliberately cannot. `infra/postgres/01-roles.sql` creates `mandate_metrics` with `SELECT`
on no table in the database, and `03-grants.sql` asserts that with a check that `RAISE`s if the
role can read one. Using postgres_exporter here means either disabling every default collector
and relying on its deprecated custom-query path, or widening the scrape credential — and a
metrics credential that can read `executions` is a credential that can read every user's
positions.

### Label discipline

No metric in this directory carries a user id, instance id, execution id, address or amount.
Those are unbounded-cardinality labels that would degrade the whole Prometheus server, and they
are also tenant data leaving the database for a store with no tenant boundary at all. Bounded
enums only: `status`, `stage`, `leg`, `mode`, `outcome`, `symbol`, `route`, `reason`.

Nothing exported here is a money amount either. Prometheus samples are float64 and this
repository's rule is that value is a bigint or a decimal string; metrics are also downsampled,
retention-limited and lossy by design, and the moment a USDC figure appears on a dashboard
somebody reconciles against it. Ratios, counts, ages and tick spacings only.

## Running it

```sh
# The exporter. Bun, not Node: relative imports carry .js extensions per this repository's ESM
# convention and Node's resolver will not map those onto .ts. Needs no credential of any kind.
MANDATE_API_URL=http://127.0.0.1:8080 bun infra/monitoring/exporter/main.ts

# The database exporter. The DSN in sql_exporter.yml is a passwordless placeholder that cannot
# authenticate under scram-sha-256; supply the real one out of band.
SQLEXPORTER_TARGET_DSN='postgres://mandate_metrics:...@127.0.0.1:5432/mandate?sslmode=require' \
  sql_exporter -config.file infra/monitoring/sql_exporter.yml

blackbox_exporter --config.file=infra/monitoring/blackbox.yml
prometheus --config.file=infra/monitoring/prometheus.yml
alertmanager --config.file=infra/monitoring/alertmanager.yml
```

Apply `infra/postgres/04-metrics.sql` first — it is what `mandate-postgres` reads, it runs after
`03-grants.sql`, and it is idempotent.

Import `grafana/mandate.dashboard.json` and pick a Prometheus datasource; the dashboard declares
one as a variable rather than hard-coding a uid. Firing alerts are overlaid as annotations.

The exporter's environment: `MANDATE_API_URL`, `EXPORTER_HOST` (default `127.0.0.1` — `/metrics`
is unauthenticated), `EXPORTER_PORT` (9109), `EXPORTER_POLL_MS` (15000, matching the API's own
market snapshot TTL), `EXPORTER_TIMEOUT_MS` (12000, above the API's 10s cold-refresh deadline so
a legitimately slow refresh is not scored as an error).

## Alerts

`severity: critical` wakes someone. `severity: warning` is a ticket. `severity: info` annotates a
dashboard and must never route to a human.

### MandateOrderRecoveryRequired

**Means:** an order reached `recovery_required` — an ambiguous receipt, a consumed unknown nonce,
a settled receipt that changed, an insufficient funded balance, or a failed refund. This halts
its own strategy *and* blocks new automatic admission for every user on the database.

**Do:** stop the worker and leave it stopped. Take a database backup. Run
`bun run worker:inspect USER_UUID EXECUTION_UUID` and verify every journal hash, receipt,
canonical block, spender nonce, approval and account transfer on Base. Do **not** restart from
`spend`, reset a funding leg, reuse a nonce, or force a retry — the shipped inspector is
read-only precisely because there is no safe blanket retry, and a pending transaction can still
mine. Recovery from ambiguous external signer use or a deep reorganisation is operator
reconciliation, not a command.

### MandateOrdersReverting

**Means:** three or more orders reverted onchain inside fifteen minutes despite every leg being
simulated before it was signed. The operator paid gas for each.

**Do:** read the revert receipts and each order's `reason`. Check the B20 token transfer pause
and oracle pause state for the symbol before assuming a venue problem — a paused token reverts
every attempt identically. If it is a paused symbol, stop admitting work for it rather than
letting each order rediscover it at gas cost.

### MandateOrderReverted

**Means:** one order reverted. Simulation and the mined block disagreed once.

**Do:** ticket, do not page. Read the receipt. A single revert is consistent with another swap
landing in the same block; if two more follow, `MandateOrdersReverting` takes over and this alert
is inhibited.

### MandateOrderRefundsElevated

**Means:** two or more funded trades failed and were refunded inside fifteen minutes. The user's
USDC had already been pulled through the spend permission, round-tripped, and the operator paid
gas both ways without charging it back.

**Do:** first confirm each refund returned the exact funded amount — a *failed* refund becomes
`recovery_required` and pages. Then find the shared cause before the next admission cycle:
symbol pause state, pool liquidity, and whether the spender's ETH balance still covers three legs
plus a refund.

### MandateOrderStuckAdmitted

**Means:** an order has been `admitted` — reserved against the signed envelope with nothing
signed — for over fifteen minutes. Its budget reservation is never credited back, so the user's
remaining allowance is being consumed by an order that will not happen.

**Do:** check that a worker holds leadership at all. If one does, the order is being skipped:
look at the instance's evaluation history for a repeating admission refusal, and at whether an
older order is blocking the queue (one leader processes one automatic order at a time across all
owners).

### MandateTransactionPendingStalled

**Means:** a transaction has been in `signed` — bytes journalled and broadcast, no receipt —
longer than `WORKER_RECEIPT_TIMEOUT_MS`. The worker has stopped waiting, so nothing is advancing
it. On a `swap` leg the user's USDC is in the spender wallet with no position bought.

**Do:** **do not resubmit and do not reuse the nonce.** A pending transaction can still mine, and
a replacement at the same nonce is how one order becomes two. Look the hash up on Base. If it
mined, reconciliation needs to run; if it was dropped, the journal is the record of what was
signed and the next step is an operator decision.

### MandateTransactionPendingSlow

**Means:** a broadcast transaction has waited five minutes for a receipt. Not yet the point where
the worker gives up, but fifty confirmation windows past normal.

**Do:** check Base for congestion and check the spender's ETH balance — an underpriced
transaction from a signer running low on gas is the common cause, and this build has no automatic
fee replacement. Do not resubmit.

### MandateEvaluationsStopped

**Means:** nothing has been evaluated in fifteen minutes while at least one armed instance is
already past due. Strategies show as armed and their rules are not running.

**Do:** check worker leadership and the worker's logs for a cycle failing before it reaches any
instance — a database readiness failure or an RPC outage at startup keeps the process alive and
idle. `mandate_worker_heartbeat_age_seconds` distinguishes "no worker" from "worker running and
stuck".

### MandateEvaluationLagCritical

**Means:** the worst-lagging armed instance is more than ten minutes past due — fifty missed
evaluations at the default cadence. Missed evaluations are never replayed, so that coverage is
gone, including any stop-loss rule the owner is relying on.

**Do:** this is throughput, not backoff (backoff moves an instance's own due time forward and
cannot produce lag). Look at RPC latency, at whether one owner's batch is monopolising the cycle,
and at `WORKER_MAX_BATCH` against the armed population.

### MandateEvaluationLagHigh

**Means:** the worst-lagging armed instance has been two minutes past due for ten minutes. Rules
are still running, just not when they were meant to.

**Do:** compare `mandate_schedule_overdue` against `mandate_schedule_armed`. A small constant
number of overdue instances is starvation; a growing fraction is throughput and will reach the
critical threshold.

### MandateEvaluationFailureRatioHigh

**Means:** more than a quarter of evaluations ended in something other than `evaluated`. Usually
an oracle, DEX or permission read that failed, or a reading that went stale before its write
committed.

**Do:** find the shared dependency before touching any strategy — the scheduler's exponential
backoff means a few failing instances produce *fewer* rows, not more, so a sustained quarter can
only be something everyone uses. Check the Base RPC first (`mandate_api_chain_ready` is an
independent read of the same thing). Public RPCs rate-limit; this workload needs one with real
capacity.

### MandateReferenceFeedUnusable

**Means:** a Chainlink round is older than 96 hours (`MAX_VALIDATION_AGE`) and can no longer
anchor the 5% deviation check. Nothing can be quoted for that symbol while its pool keeps
trading.

**This is deliberately not the 26-hour bound.** `MAX_REFERENCE_AGE` (26h) answers "is this a live
market price" and drives the `stale` flag users see. These Coinbase total-return feeds have no
off-hours heartbeat and hold the last close; measured on a Sunday, all seven symbols were 37–43
hours old while their Aerodrome pools traded normally. An alert at 26 hours fires every single
weekend and gets muted, which is how you lose the alert that matters.

**Do:** check the aggregator on Base directly — if it is publishing and we are not seeing it, the
fault is the RPC, not Chainlink. Expect and accept refused quotes meanwhile. Do **not** widen
`MAX_VALIDATION_AGE` to clear this: it silently authorises trading against a price that no longer
describes the asset.

### MandateReferenceFeedApproachingUnusable

**Means:** a round is over 72 hours old. The feed heartbeat is 24 hours, so it has exactly one
heartbeat of margin left before quoting stops. An ordinary Friday-to-Monday gap is about 64 hours
and stays under this; a holiday Monday reaches roughly 88 hours and will trip it, correctly.

**Do:** confirm the market is genuinely closed rather than the feed abandoned, and check for a
corporate-action pause on the symbol. For an ordinary long weekend, no action beyond knowing.

### MandateReferenceFeedUnreadable

**Means:** no round at all was read for a symbol — not an old price, no price. `assessRound`
throws outright on a non-positive answer, an unanswered round, a future timestamp or a
carried-over answer, so this is a structural fault in the read path.

This alert has to exist separately because an unreadable feed publishes a NaN age, and NaN fails
every comparison — it would silently never trip the staleness alerts no matter how long it
lasted.

**Do:** check `mandate_api_chain_ready` first; if the chain read is failing generally this is an
RPC incident and every symbol shows it. If one symbol only, verify its feed address in
`packages/evm/src/addresses/index.ts` against the aggregator live on Base.

### MandateCatalogueCoverageDegraded

**Means:** fewer than five catalogue entries have a quote inside the 500 bps band. Five is the
measured baseline, not seven: AAPLc, GOOGLc, METAc, NVDAc and TSLAc route at the 10 USDC probe
size; MSFTc and AMZNc do not, on ~$150k pools.

**Do:** find which symbol dropped and why with `mandate_asset_blocked{reason=~".+"} == 1`.
`no-priced-route` is liquidity, `quote-deviation` is a pool that has drifted from the reference,
and `chain-unavailable` is an RPC incident rather than a market event at all.

### MandateQuoteDeviationHigh

**Means:** a pool price is more than 250 bps from its Chainlink reference — half the 500 bps
refusal band, and roughly fifty times the measured healthy figure (AAPLc/USDC quoted $320.22
against a $320.08 reference).

**Do:** decide which side is wrong before doing anything. Check `mandate_reference_age_seconds`
for the symbol: after a weekend gap-open the close under-reflects the true price and the pool is
right. If the reference is fresh, the pool has drifted and refused orders are the correct
outcome, not a wider band.

### MandateWorkerHeartbeatLost

**Means:** the leader's heartbeat is stale, so nothing is evaluating strategies or advancing
orders, and the API is telling every client `execution_available: false`. An age of 86400 means
no worker has ever run against this database.

**Do:** check whether the process is alive before restarting anything. If it is alive and not
beating, leadership was lost — a transaction-mode pooler in front of PostgreSQL cannot hold the
session advisory lock, which is the usual cause after an infrastructure change. Durable state is
safe across a restart; the journal is what makes that true.

### MandateWorkerCannotExecute

**Means:** the leader is alive and reporting that it cannot execute *while at least one automatic
strategy is armed*. That last clause is why this is alertable at all — `WORKER_EXECUTE=0` is the
default and the correct state of an observation deployment.

**Do:** if `MandateOrderRecoveryRequired` is also firing, that is the cause and this is the
symptom (and is inhibited). Otherwise this is configuration: live execution needs all of
`WORKER_EXECUTE=1`, a worker-only private key, the matching public `SPENDER_ADDRESS`, and an
`ELIGIBLE_COUNTRIES` allowlist matching the API.

### MandateSpendPermissionStranded

**Means:** an instance is armed and automatic with no active spend permission — revoked onchain,
expired, or never signed. It evaluates on schedule and is refused at the funding gate every time
while the interface shows it alive.

**Do:** establish whether the user revoked deliberately; onchain revocation is the authority stop
and is a legitimate thing for them to do, in which case the strategy should be paused rather than
left armed. If not, re-read the permission from `SpendPermissionManager` — the stored `status` is
this server's observation of the chain and can simply have missed the transition.

### MandateSpendPermissionExpiringImminently

**Means:** authority behind an armed strategy expires within the hour.

**Do:** send the renewal prompt if it has not gone already, and stop expecting fills. Consider
pausing the strategies rather than leaving them armed and failing, so the user's history does not
fill with funding refusals. No operator action renews it — only the account holder can sign.

### MandateSpendPermissionExpiringSoon

**Means:** authority behind an armed strategy expires within 24 hours. Nothing is broken yet.

**Do:** prompt the account holder to re-grant. The 24-hour window is the same one the eligibility
attestation uses, so one prompt can cover both.

### MandateApiUnreachable

**Means:** an external probe got no HTTP response at all. The probe accepts both 200 and 503, so
this explicitly does not mean "unready".

**Do:** check the process and the listener. If the process is up and the probe still fails, look
at what is in front of it — the API sets `trustProxy: false` and binds explicitly, so a proxy
answering on its behalf is a misconfiguration rather than a fallback.

### MandateApiUnready

**Means:** `GET /ready` is answering 503 and load balancers are taking the instance out of
rotation. A missing worker never causes this; `execution_available` is reported but is
deliberately not part of the verdict.

**Do:** read `mandate_api_database_ready` and `mandate_api_chain_ready` to see which. A false
database check is not always an outage — `databaseReady()` also refuses when the connection is a
superuser or `BYPASSRLS` role, because that would bypass the row-level security isolating users.
Check `DATABASE_URL` before assuming PostgreSQL is down.

### MandateApiErrorRateHigh

**Means:** more than a tenth of probes across `/health`, `/ready` and `/v1/market` are not
returning the answer those routes are defined to give. The API funnels every unhandled exception
into one error handler that produces a 500, so a sustained non-ok share is a server fault.

**Do:** break it down by route with `mandate_api_probe_responses_total`. `/v1/market` failing
alone is the chain read path (that route composes oracle reads and a quoter probe per asset);
`/health` failing means the process itself. Then read the API logs for the `code` field — the
error handler logs a problem code and deliberately never the upstream error object, which can
contain credentials.

### MandateMarketExporterStale

**Means:** the exporter has not completed a successful market collection in over two minutes. It
is still serving its last values by design — stale numbers with a stated age beat a blank scrape
— which means every reference figure above is frozen.

**Do:** this is usually the API rather than the exporter; check `MandateApiUnready` and the
`/v1/market` probe outcome first. Until it clears, treat every per-symbol gauge as unverified
rather than as evidence that nothing has changed.

### MandateMonitoringTargetDown

**Means:** Prometheus cannot scrape a target. Every rule reading it has stopped evaluating, and
silence from a rule is indistinguishable from health.

**Do:** restart the named exporter. If it is `mandate-postgres`, check the scrape credential
first — it comes from `SQLEXPORTER_TARGET_DSN` and the placeholder DSN in `sql_exporter.yml`
deliberately cannot authenticate.

### MandateExporterDroppingSymbols

**Means:** the exporter refused catalogue entries — a malformed symbol, a duplicate, or an entry
past the cardinality ceiling. Those assets are missing from every per-symbol gauge, so the
staleness alerts are silently not covering them.

**Do:** confirm `MANDATE_API_URL` points at the intended API. If the catalogue genuinely grew,
raise `MAX_SYMBOLS` in `exporter/samples.ts` deliberately — the ceiling exists because an
unbounded label set degrades the whole Prometheus server, not just this job.

## Deliberately not alerted on

**`mandate_reference_stale`** — the API's 26-hour display verdict. Every symbol sits at 1 for the
whole of every weekend by design. It is on the dashboard and a test asserts that no rule reads
it.

**Tick spacing changes.** `mandate_asset_quote_tick_spacing` is a dashboard panel, not an alert.
The tick-spacing trap is real — AAPLc/USDC quotes $320.22 at spacing 10 and $37,861 at spacing
200, 11,729% out — but the alert that catches its *consequence* is `MandateQuoteDeviationHigh`,
and an alert on the spacing itself would fire every time liquidity migrated between two perfectly
healthy pools.

**`mandate_permission_authority_expiring_72h`** — a lead indicator with no action attached at
that range. Charted, not alerted.

**Prices.** No USDC or share price is exported at all. See "Label discipline".

**Cost, latency and throughput SLOs.** There is no per-request latency histogram to build them
from; see below.

## Needs wiring elsewhere

1. **Per-route API request metrics.** The application has no request counter — `packages/observability`
   ships logger configuration only, and no `/metrics` route exists on the Fastify app. So
   `MandateApiErrorRateHigh` measures three declared routes from one prober at 4 requests a
   minute, not user traffic. A real error rate needs an `onResponse` hook recording
   `{method, route, status_code}` (Fastify's `request.routeOptions.url`, never `request.url`, or
   the path parameters become label cardinality) and a `/metrics` route bound to loopback. Both
   changes are in `apps/api/src`, which this directory does not own.

2. **`04-metrics.sql` must be applied and re-applied.** It runs after `03-grants.sql` and is
   idempotent, but a deployment that skips it leaves `mandate-postgres` failing every scrape —
   visible as `MandateMonitoringTargetDown` rather than silently.

3. **Alertmanager receivers are empty.** `page`, `ticket` and `record` are valid and silently
   drop. An unwired `page` receiver looks exactly like a quiet system; wire them before relying
   on any of this.

4. **The exporter is not containerised here.** `infra/docker` owns container definitions. It runs
   as `bun infra/monitoring/exporter/main.ts` with no credential and no database handle.

## Verification

```sh
bun test infra/monitoring/test
```

`promtool` is not installed in this workspace and the Docker daemon is not running, so
`promtool check rules` could not be run — and it only covers syntax in any case. The suite here
checks what promtool would not:

* every metric an alert selects is produced by the collector, the exporter or Prometheus itself,
  and every metric that is produced is read by a rule or shown on the dashboard;
* every alert has a severity, a delay and all five annotations, and every numeric threshold in an
  expression appears verbatim in that alert's own `derivation`;
* every `runbook` anchor resolves to a heading in this file;
* every alertname in an inhibit rule exists, and per-symbol suppression is scoped by symbol;
* every severity a rule emits has a route and every route matches a severity in use;
* the feed-staleness threshold is exactly `96 * 3600`, no rule reads the 26-hour gauge, and ages
  of 37/40/43/64/88 hours (measured, and a holiday weekend) do not cross it while 97 and 120 do;
* the exporter's mapping: NaN for an unread round rather than a 1.7-billion-second age, a 503
  from `/ready` scored as success, one-hot blockers including the zeroes, decimal-string parsing
  that refuses `1e3`, duplicate-symbol rejection (a duplicate label set makes Prometheus discard
  the *entire* scrape), and no `0x…` address reaching the exposition.

The exporter was also run end to end against a fixture API serving the seven-symbol catalogue,
and its `/metrics` output inspected.
