#!/usr/bin/env bash
# Give any wallet fork USDC and ETH so a real login can trade on the local chain.
#   scripts/dev/fork-fund.sh 0xYourWallet [usdc-amount]
# USDC (FiatTokenV2_2) keeps balances in mapping slot 9; the balance is written straight into
# storage, the same way apps/api/fork/seed.ts funds the test accounts.
set -euo pipefail
ADDR="${1:?wallet address}"; AMOUNT="${2:-10000}"
RPC="${FORK_RPC_LOCAL:-http://127.0.0.1:8545}"
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
SLOT=$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$ADDR" 9)")
cast rpc anvil_setStorageAt "$USDC" "$SLOT" "$(cast to-uint256 $((AMOUNT * 1000000)))" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$ADDR" "$(cast to-uint256 1000000000000000000)" --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
echo "$ADDR: $(cast call $USDC 'balanceOf(address)(uint256)' "$ADDR" --rpc-url "$RPC") USDC units, $(cast balance "$ADDR" --rpc-url "$RPC" --ether) ETH"
