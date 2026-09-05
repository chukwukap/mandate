# Worker verification

Implemented on 2026-09-05 in `apps/worker`, `packages/execution` and the shared
database/configuration packages. The original Rust app and web scaffold are not
part of this change.

Verification covers:

- Atomic evaluation and manual signals, stale work suppression, unavailable
  observations, disabled execution and eligibility expiry.
- Restart from persisted bytes, receipt-driven leg advancement, exact refund
  signing, funding failure, funded swap failure, pause/kill, ambiguous nonces and
  changed settled receipts.
- Immutable transaction journal, tenant isolation, native PostgreSQL leader
  exclusion and generation fencing.
- Cooldown across multiple actions, period/lifetime reservations, cumulative
  position reservations and expiry.
- Built Node worker startup, heartbeat and shutdown; API regression tests and
  heartbeat availability reporting.

Signing tests use a deterministic unfunded fixture key and mocked RPC calls. The
native integration script uses a disposable local cluster and local RPC fixture.
No funded mainnet execution, real Privy login or mainnet refund was performed.

Final checks: 21 worker tests passed with the in-process database; the additional
leader-election test passed against native PostgreSQL. All 47 API/shared regression
tests passed. The native suite passed 22 API/worker integration cases, rebuilt both
Node apps and verified API readiness plus worker heartbeat and graceful shutdown.
TypeScript and Biome checks passed.

## Contract evidence

Read the canonical [B20 interface](https://github.com/base/base-std/blob/main/src/interfaces/IB20.sol)
for transfer pause and bytes32 policy scopes, and Coinbase's
[SpendPermissionManager](https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol)
for spender-only funding and current-period accounting.

Read the deployed oracle registry's
[verified contract and ABI](https://base.blockscout.com/address/0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD?tab=contract):
`getOracleParams(address)` returns `(uint256 multiplier, bool paused)`.
A read-only Base RPC probe confirmed AAPLc multiplier `1000000000000000000`,
oracle pause `false`, transfer pause `false`, receiver policy scope
`0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363`,
and policy ID `5`. These are observations, not permanent policy assumptions;
the worker reads current values at execution time.

Operational limits, accounting semantics and unresolved-order handling are in the
[worker runbook](../runbooks/worker-local.md).
