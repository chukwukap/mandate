import type { Call, Hex, PermissionPayload } from "@mandate/contracts";
import { encodeFunctionData, hashTypedData, parseAbi } from "viem";
export const CHAIN_ID = 8453;
export const SPEND_MANAGER = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad" as const;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const permissionAbi = parseAbi([
  "struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }",
  "function approveWithSignature(SpendPermission permission, bytes signature) returns (bool)",
  "function revoke(SpendPermission permission)",
  "function isApproved(SpendPermission permission) view returns (bool)",
  "function isRevoked(SpendPermission permission) view returns (bool)",
]);
export const permissionTypes = {
  SpendPermission: [
    { name: "account", type: "address" },
    { name: "spender", type: "address" },
    { name: "token", type: "address" },
    { name: "allowance", type: "uint160" },
    { name: "period", type: "uint48" },
    { name: "start", type: "uint48" },
    { name: "end", type: "uint48" },
    { name: "salt", type: "uint256" },
    { name: "extraData", type: "bytes" },
  ],
} as const;
export function permissionMessage(payload: PermissionPayload) {
  return { ...payload, allowance: BigInt(payload.allowance), salt: BigInt(payload.salt) };
}
export function permissionTypedData(payload: PermissionPayload) {
  return {
    domain: {
      name: "Spend Permission Manager",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: SPEND_MANAGER,
    },
    types: permissionTypes,
    primaryType: "SpendPermission" as const,
    message: permissionMessage(payload),
  };
}
export function permissionHash(payload: PermissionPayload): Hex {
  return hashTypedData(permissionTypedData(payload));
}
// JSON keeps uint160/uint256 as strings; clients may convert those to bigint for signing.
export function permissionJson(payload: PermissionPayload) {
  return { ...permissionTypedData(payload), message: payload };
}
export function approvalCall(payload: PermissionPayload, signature: Hex): Call {
  return {
    to: SPEND_MANAGER,
    chain_id: CHAIN_ID,
    value: "0",
    data: encodeFunctionData({
      abi: permissionAbi,
      functionName: "approveWithSignature",
      args: [permissionMessage(payload), signature],
    }),
  };
}
export function revocationCall(payload: PermissionPayload): Call {
  return {
    to: SPEND_MANAGER,
    chain_id: CHAIN_ID,
    value: "0",
    data: encodeFunctionData({
      abi: permissionAbi,
      functionName: "revoke",
      args: [permissionMessage(payload)],
    }),
  };
}
