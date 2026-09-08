# Testing execution against a forked Base mainnet

The full product — draft, signature, spend permission, worker, swap — run locally against real
Base state, with no real funds and no mainnet transactions.

## Why some contracts are replaced

The seven Coinbase B20 tokens are **not EVM contracts**. Their onchain code is the single byte
`0xef`, which EIP-3541 reserves precisely so that nothing ordinary can begin with it: the logic
lives inside Base's execution client as a native precompile. Anvil runs revm, so any call that
touches one fails with `OpcodeNotFound` — at every hardfork, because it is not a hardfork
question. The same is true of Base's oracle registry and policy registry.

Everything else forks intact and is used as-is:

| Real on the fork | Replaced, and why |
| --- | --- |
| USDC, and its balances | The 7 B20 tokens — native precompiles |
| Chainlink price *answers* | Chainlink `updatedAt` — a pinned fork freezes it, and the worker rejects a reference older than 300s |
| Aerodrome factory, quoter, router, and every pool's slot0/liquidity/ticks | Base oracle registry `getOracleParams` — native precompile |
| Coinbase `SpendPermissionManager` | Base policy registry `isAuthorized` — native precompile |
| Coinbase Smart Wallet factory and account | — |

Each replaced value mirrors what mainnet returns: pool reserves are copied from the real pools,
`getOracleParams` answers `(1e18, false)`, `policyId` answers `5`, and each feed carries the
answer it held at the forked block. So the pool math, the routing, the permission ceremony and
the whole worker pipeline are exercised for real; only the parts an EVM cannot run are stubbed.

## Running it

```sh
createdb -O mandate_owner mandate_fork
MIGRATION_DATABASE_URL=postgresql://mandate_owner@127.0.0.1:5432/mandate_fork \
  node --import tsx scripts/database/migrate.ts
psql postgresql://mandate_admin@127.0.0.1:5432/mandate_fork -f infra/postgres/03-grants.sql
```

`.env.fork` and `.env.worker.fork` are the normal API and worker settings with three changes:
`DATABASE_URL` points at `mandate_fork`, `BASE_RPC_URL` at `http://127.0.0.1:8545`, and the API
listens on 8081 so a mainnet stack can keep running beside it. The worker needs
`WORKER_EXECUTE=1` and `WORKER_CONFIRMATIONS=2` (the configured floor).

```sh
bash scripts/dev/fork-up.sh                                  # anvil, seeding, API, worker
bun --env-file=.env.fork apps/api/fork/multi-token.ts        # the end-to-end
```

`fork-up.sh` pins a block, seeds, then aligns the chain clock to the wall clock — without that
every Chainlink answer looks hours stale, because a pinned fork keeps building on the forked
block's timestamp while the worker measures freshness against `Date.now()`.

## Things that will look like bugs and are not

- **Nothing executes outside 09:35–15:55 ET, Mon–Fri.** `executionSession` refuses; the
  evaluation is recorded as `observation-or-authority-unavailable`.
- **The first `/v1/market` after a cold fork reports every `dex:` feed null.** Routing probes six
  tick spacings per asset against an unwarmed fork and exceeds the 5s RPC timeout, and the result
  is cached for 15s. It settles by the second poll.
- **Anvil aborts if its fork backend rate-limits.** It does not retry past its limit; it panics.
  Use an endpoint that serves archive state (`https://mainnet.base.org` does) and avoid interval
  mining, which refetches L1 system-account storage on every block.
- **AAPLc's tick-spacing-200 pool quotes thousands of dollars a share.** That is real mainnet
  state faithfully reproduced, and it is why routing sanity-checks every quote against Chainlink.
