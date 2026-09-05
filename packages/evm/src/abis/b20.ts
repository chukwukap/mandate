import { parseAbi } from "viem";

/**
 * Coinbase B20 tokenized-equity extensions over ERC20, plus the two registries that gate
 * transfers. Signatures transcribed from the deployed tokens and exercised by
 * apps/worker/src/chain.ts against Base mainnet.
 *
 * These reads are not decoration. A B20 token can be transfer-paused by the issuer while
 * its Chainlink feed keeps publishing a perfectly fresh price, and the recipient must be
 * authorized under the token's transfer-receiver policy or the swap reverts after the
 * spend permission has already been drawn down. Price freshness alone never implies the
 * token is movable.
 */
export const b20TokenAbi = parseAbi([
  "function isPaused(uint8 feature) view returns (bool)",
  "function TRANSFER_RECEIVER_POLICY() view returns (bytes32)",
  "function policyId(bytes32 scope) view returns (uint64)",
]);

/**
 * B20 oracle registry 0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD.
 *
 * `multiplier` is the share multiplier already baked into the Chainlink answer. Reading it
 * here is a liveness check (multiplier == 0 or paused == true means do not trade); it must
 * NOT be applied to the feed answer a second time, which would scale every price by the
 * multiplier squared.
 */
export const b20OracleRegistryAbi = parseAbi([
  "function getOracleParams(address token) view returns (uint256 multiplier,bool paused)",
]);

/** B20 policy registry 0x8453000000000000000000000000000000000002. */
export const b20PolicyRegistryAbi = parseAbi([
  "function isAuthorized(uint64 policy, address account) view returns (bool)",
]);
