# Execution

`Admission` verifies the immutable signed review, obtains observations and atomically
persists runtime, evaluations and intents. `Lifecycle` advances a persisted order
through funding, approval and swap, or allowance reset and refund. It writes signed
transaction bytes before broadcasting and reconciles receipts before further work.

Chain reads/signing implement the `Observations` and `Executor` interfaces. Tests can
exercise crash recovery without a signer or network. See the
[worker runbook](../../docs/runbooks/worker-local.md) for accounting and recovery limits.
