# Strategy

Runtime plan validation, decimal quantities, deterministic review commitments,
Anthropic text authoring and a pure state-machine evaluator. The API uses the
`mandate/2` artifact format; the worker uses `tick` to produce runtime changes,
intents, refusals and notification records.

Admission persists the tick atomically. Budget counters reserve admitted amounts;
period/lifetime caps, cooldown, repeat limits and cumulative position availability
constrain intents. Position-scoped machines are rejected. The evaluator does not
perform chain reads, sign transactions or prove full parity with the Rust runtime.

See [worker admission](../../docs/architecture/worker.md) and
[rewrite compatibility](../../docs/migration/README.md).
