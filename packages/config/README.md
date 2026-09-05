# Configuration

`loadConfig` validates API settings; `loadWorkerConfig` validates the worker's
separate environment. API credentials include Privy; the worker requires no Privy
secret and loads its signer only with execution explicitly enabled.

See the [configuration reference](../../docs/reference/configuration.md),
[API setup](../../docs/runbooks/api-local.md) and [worker setup](../../docs/runbooks/worker-local.md).
