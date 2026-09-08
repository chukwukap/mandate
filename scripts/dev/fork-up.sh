#!/usr/bin/env bash
# Bring up a forked Base mainnet with the B20 tokens made executable, then the API and worker.
#
# Why a fork plus replacements rather than one or the other: the B20 tokens are NOT EVM
# contracts. Their onchain code is the single byte 0xef — reserved by EIP-3541 — because the
# logic lives inside Base's execution client as a native precompile. No EVM simulator can run
# them. Everything else the product touches (USDC, Chainlink, Aerodrome, Coinbase's
# SpendPermissionManager and Smart Wallet factory) is ordinary bytecode and forks intact, so only
# the seven tokens are replaced, at their real addresses, with their real pool balances.
set -euo pipefail
cd "$(dirname "$0")/../.."
STATE="${STATE_DIR:-/tmp/mandate-fork}"
mkdir -p "$STATE"
BLOCK="${FORK_BLOCK:-51038500}"
RPC="${FORK_RPC:-https://mainnet.base.org}"

pkill -f "apps/api/src/main.ts" 2>/dev/null || true
pkill -f "apps/worker/src/main.ts" 2>/dev/null || true
pkill -f anvil 2>/dev/null || true
sleep 2

# No interval mining. Anvil refetches L1 system-account storage from the fork backend on every
# block it builds, so a 2s interval is 30 upstream requests a minute purely to sit idle — enough
# for a public endpoint to start refusing, and anvil aborts rather than retrying past its limit.
# Blocks are produced by the ticker below instead, slowly, and by transactions themselves.
# --hardfork cancun, deliberately behind Base's actual fork. Prague's EIP-2935 has the node write
# each block's parent hash into the history contract at 0x0000f908…2935 during pre-execution,
# which reads a NEW ring-buffer slot every block — never cached, always an upstream round trip.
# On a public endpoint one of those eventually fails and anvil panics instead of retrying past
# its limit; that was every crash this fork has had, at 0x0000f908…2935 each time. Nothing the
# product touches needs a Prague opcode (the mocks are compiled for cancun), so the fork gives
# up nothing by staying one fork behind and stops depending on the backend to make a block.
anvil --fork-url "$RPC" --fork-block-number "$BLOCK" --chain-id 8453 --port 8545 --silent --hardfork cancun \
  --accounts 5 --balance 1000 --retries 20 --fork-retry-backoff 3000 \
  --compute-units-per-second 60 --timeout 120000 > "$STATE/anvil.log" 2>&1 &
for _ in $(seq 1 40); do cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 && break; sleep 1; done
echo "anvil up at block $(cast block-number --rpc-url http://127.0.0.1:8545)"

bun run apps/api/fork/seed.ts

# Align the chain clock with the wall clock. A pinned fork keeps building on the forked block's
# timestamp, so block.timestamp trails real time by however long ago that block was — and the
# worker measures oracle freshness (300s) and permission windows against Date.now(). Without
# this every reference looks hours stale no matter how sound the rest of the system is.
cast rpc evm_setTime "$(date +%s)" --rpc-url http://127.0.0.1:8545 >/dev/null
cast rpc evm_mine --rpc-url http://127.0.0.1:8545 >/dev/null

# Confirmations need blocks to keep arriving; the worker's floor is 2. One block every 10s is
# enough for that and a sixth of the upstream pressure a 2s interval creates.
( while sleep 10; do
    cast rpc evm_mine --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 || exit 0
  done ) & echo $! > "$STATE/ticker.pid"

psql "postgresql://mandate_admin@127.0.0.1:5432/mandate_fork" -qtAc \
  "truncate mandate_v2.drafts, mandate_v2.instances, mandate_v2.permissions, mandate_v2.evaluations, mandate_v2.executions, mandate_v2.transactions, mandate_v2.users, mandate_v2.worker_state cascade" >/dev/null
node --env-file=.env.fork --import tsx apps/api/src/main.ts > "$STATE/api.log" 2>&1 &
node --env-file=.env.worker.fork --import tsx apps/worker/src/main.ts > "$STATE/worker.log" 2>&1 &
for _ in $(seq 1 40); do
  curl -sf http://127.0.0.1:8081/ready 2>/dev/null | grep -q '"execution_available":true' && break
  sleep 1
done
echo "api: $(curl -s http://127.0.0.1:8081/ready)"
