# Fastify API

Node.js runs the server; Bun manages dependencies, builds and tests.

The API owns Privy-authenticated authoring, immutable signed reviews, spending
permission preparation/verification, lifecycle controls, read-only market quotes
and execution history. It never signs or broadcasts transactions.

See [local setup](../../docs/runbooks/api-local.md),
[API contracts](../../docs/api/README.md) and
[completion criteria](../../docs/api/acceptance.md).

The [worker](../worker/README.md) evaluates armed instances and owns transaction
execution. The web app remains a scaffold. An armed instance or live heartbeat
does not guarantee an eligible, executable trade.
