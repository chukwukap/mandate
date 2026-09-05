# Worker architecture

The worker is a Node.js process with no HTTP listener. It consumes API-created
instances and immutable signed reviews from PostgreSQL. It uses the same user IDs
and tenant isolation as the API, while holding its own signing configuration.

## Code ownership

| Component | Responsibility |
| --- | --- |
| [main.ts](../../apps/worker/src/main.ts) | Configuration, startup checks, leadership, heartbeat and shutdown. |
| [worker.ts](../../apps/worker/src/worker.ts) | Outstanding-order priority and bounded due-instance scheduling. |
| [chain.ts](../../apps/worker/src/chain.ts) | Observations, authority checks, simulation, signing and chain evidence. |
| [admission.ts](../../packages/execution/src/admission.ts) | Review verification and atomic evaluation/runtime/intent persistence. |
| [lifecycle.ts](../../packages/execution/src/lifecycle.ts) | Receipt-driven order progression and refund decisions. |
| [database worker support](../../packages/database/src/worker.ts) | Leader fencing, tenant-scoped work queries and journal reads. |

## Leadership and scheduling

A dedicated PostgreSQL connection holds session advisory lock `(8453, 2026)`.
Other worker processes wait. The leader records a generation UUID in `worker_state`;
every worker write checks that generation under a row lock and requires a heartbeat
no older than 30 seconds. Losing leadership prevents new journal commits.

Each cycle first searches for outstanding automatic work. An outstanding order
blocks new admissions across users; `recovery_required` blocks progression until
operator reconciliation. With no outstanding work, the worker pages owners and
selects due armed instances. Queries retain tenant context rather than bypassing
row-level security. The owner scan remains proportional to the user count.

Use direct connections or session-mode pooling. Transaction-mode pooling cannot
preserve the session advisory lock. One signer must not be shared across databases
or used by an independent sender.

## Admission

1. Rebuild and verify the signed review commitment, plan, asset catalogue and wallet signature.
2. For automatic mode, check execution enablement, eligibility, active permission,
   execution window, reference freshness, oracle pause and recipient policy.
3. Read prices and actual wallet balances. Missing observations fail the evaluation;
   they are not replaced with zero.
4. Lock the instance and reject stale work if status, update timestamp or due time changed.
5. Evaluate the state machine and persist the evaluation, updated runtime and order
   intents in one transaction.

Manual intents receive `signal` status and never enter the transaction pipeline.
Automatic intents receive `admitted`. Disabled execution or failed preflight leaves
rule edges and budget counters unfired. Expired eligibility pauses an automatic
instance; an eligible API arm request renews the attestation. A halt action suppresses
all new intents from that evaluation, including orders listed before the halt.

Budget counters reserve admitted amounts. Cancelled/refunded orders do not release
those reservations automatically. Multiple actions in one firing share its cooldown;
sell signals cannot reserve the same position balance twice in one tick. Equity
sizing values USDC and the strategy's allowlisted stock positions.

## Order and transaction states

| Order status | Meaning |
| --- | --- |
| `signal` | Manual intent only. |
| `admitted` | Automatic intent committed; no transaction necessarily signed yet. |
| `pending` | Transaction pipeline or funded-input return in progress. |
| `confirmed` | Successful swap with required receipt evidence. |
| `reverted` | Funding reverted; no funded-input return is needed. |
| `cancelled` | Order stopped or rejected before funding. |
| `refunded` | Required receipt evidence confirms input returned to the account. |
| `recovery_required` | Safe progression cannot be established; operator review required. |

Each journal row has a separate status: `signed`, `confirmed` or `reverted`.
`stage` identifies the pipeline leg and must not be interpreted as settlement.

| Leg | Action and destination |
| --- | --- |
| `fund` | SpendPermissionManager pulls the exact USDC input into the spender wallet. |
| `approve` | Set the router allowance to the input amount. |
| `swap` | Execute the buy with the strategy account as output recipient. |
| `reset` | Clear router allowance before returning funded input. |
| `refund` | Transfer exactly the funded USDC input back to the strategy account. |

Authority, rule conditions and quotes are checked again during preparation.
Funding intents older than 60 seconds are rejected. Simulation and nonce checks
precede signing. The resulting bytes, hash, signer, nonce and expected transfer
evidence must commit before a later cycle can broadcast them.

## Restarts and partial failures

For an unresolved journal entry, the worker checks its receipt and resends identical
bytes when evidence still indicates pending work. It does not construct another
funding transaction or infer success from a consumed nonce. Previously settled legs
are checked again before progressing to a subsequent leg.

A stopped strategy after funding, a failed approval/swap, or unavailable execution
can lead to allowance reset and refund. The worker never sweeps the spender wallet.
An unknown consumed nonce, changed settled receipt, unresolved timeout, insufficient
funded balance or failed return can require operator review instead.

This is a multi-transaction custody path, not an atomic swap from the user's wallet.
Confirmation checks cannot guarantee protection against a deep reorganization after
completion. Pause/kill prevents newly prepared funding, but already journaled bytes
may still be broadcast or settle. Revoking the onchain permission is a separate step.

## Observability and shutdown

The API reads the leader heartbeat for `execution_available`. This reports worker
capability, not strategy eligibility or guaranteed execution. Per-instance evaluation
and execution endpoints explain recorded outcomes; the journal inspector reveals
metadata without printing raw signed bytes.

SIGINT/SIGTERM stops scheduling, releases leadership and closes the database pool.
The shutdown deadline is 30 seconds. Persisted transactions survive process exit.
Metrics, distributed tracing, fee replacement and an operator recovery UI remain
future work. See [operating instructions](../runbooks/worker-local.md) and
[verification evidence](worker-verification.md).
