# Node.js worker

`src/main.ts` owns configuration, leadership, lifecycle and shutdown.
`src/worker.ts` schedules due strategies and prioritizes outstanding transactions.
`src/chain.ts` checks Base authority/market conditions and signs, simulates and
reconciles transactions. Admission and durable execution live in `@mandate/execution`;
PostgreSQL coordination and tenant-scoped queries live in `@mandate/database`.

See [setup, execution limits and recovery](../../docs/runbooks/worker-local.md).
