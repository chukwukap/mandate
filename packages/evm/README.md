# EVM integration

Base reads, B20 catalogue, reference validation, directional Aerodrome quotes,
wallet capability checks and spending-permission calldata. This package does not
hold private keys or broadcast transactions. The execution adapter lives in
[apps/worker/src/chain.ts](../../apps/worker/src/chain.ts).

Quotes use exact raw units and are read-only observations; they do not establish
eligibility, an open execution session or permission to trade. See
[API market semantics](../../docs/api/README.md) and
[worker checks](../../docs/architecture/worker.md).
