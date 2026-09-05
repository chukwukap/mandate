# Observability

Shared Fastify/Pino logger configuration redacts credentials, signatures, signed
transaction bytes and request bodies. The API emits request IDs; worker logs cover
startup, leadership loss, cycle failure and shutdown without printing upstream
exceptions that may contain secrets.

Worker heartbeat is stored in PostgreSQL. Per-instance evaluation/execution history
and the read-only journal inspector provide operational evidence. Metrics and
distributed tracing are not implemented.

See [worker operations](../../docs/runbooks/worker-local.md).
