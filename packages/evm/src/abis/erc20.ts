import { parseAbi } from "viem";

// Re-exported rather than re-declared: viem ships the canonical ERC20 fragment, and a
// hand-copied duplicate is one typo away from encoding a transfer with the wrong selector.
export { erc20Abi } from "viem";

/**
 * Read-only ERC20 surface used to verify a catalogue asset before trusting its feed.
 * Deliberately narrower than `erc20Abi`: verification code holds an ABI that physically
 * cannot encode `transfer`/`approve`, so a mistaken `encodeFunctionData` there fails to
 * compile instead of producing a spendable calldata blob.
 */
export const erc20MetadataAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
