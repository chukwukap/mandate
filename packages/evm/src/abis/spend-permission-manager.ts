import { parseAbi, parseAbiParameter } from "viem";

/**
 * Coinbase SpendPermissionManager, 0xf85210B21cC50302F477BA56686d2019dC9b67Ad on Base (8453).
 *
 * The `SpendPermission` struct layout is load-bearing twice over: it fixes the calldata
 * encoding here AND it is the EIP-712 type the user signs in permissions/index.ts. The two
 * must stay byte-identical — a struct whose fields drift produces a signature the manager
 * hashes to a different permission, which reverts on chain after the user has already
 * approved something they cannot use. permissions/index.ts owns the typed-data copy;
 * test/abis.test.ts asserts the two encode the same calldata.
 *
 * Signatures transcribed from the deployed contract and already exercised against Base
 * mainnet by permissions/index.ts (approveWithSignature, revoke, isApproved, isRevoked)
 * and apps/worker/src/chain.ts (spend, getCurrentPeriod).
 */
export const spendPermissionManagerAbi = parseAbi([
  "struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }",
  "struct PeriodSpend { uint48 start; uint48 end; uint160 spend; }",
  "function approve(SpendPermission permission) returns (bool)",
  "function approveWithSignature(SpendPermission permission, bytes signature) returns (bool)",
  "function revoke(SpendPermission permission)",
  "function revokeAsSpender(SpendPermission permission)",
  "function spend(SpendPermission permission, uint160 value)",
  "function getHash(SpendPermission permission) view returns (bytes32)",
  "function isApproved(SpendPermission permission) view returns (bool)",
  "function isRevoked(SpendPermission permission) view returns (bool)",
  "function isValid(SpendPermission permission) view returns (bool)",
  "function getCurrentPeriod(SpendPermission permission) view returns (PeriodSpend)",
  "function getLastUpdatedPeriod(SpendPermission permission) view returns (PeriodSpend)",
]);

/**
 * The struct as a standalone ABI parameter. Two uses: encoding/decoding a permission
 * without the whole manager surface, and giving tests a machine-readable field list to
 * diff against the EIP-712 `permissionTypes` in permissions/index.ts. Order and width
 * must match that list exactly, so a drift there is caught before it reaches a signer.
 */
export const spendPermissionParameter = parseAbiParameter(
  "(address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData) permission",
);
