import { type Hex, Problem } from "@mandate/contracts";
import { encodeFunctionData, parseAbi } from "viem";

/**
 * The one chain read signature verification needs, behind a port.
 *
 * `ChainReader` in `@mandate/contracts` already answers two *specific* signature questions
 * (`verifyMessage` for a plaintext message, `verifyPermission` for one hard-coded struct) and
 * neither can answer "does this account accept this arbitrary digest?". Rather than widening that
 * interface — every implementation, including the worker's and the test doubles, would have to
 * grow a method — this module states its own two-method requirement and ships one adapter.
 */

/** EIP-1271: `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`. */
export const ERC1271_MAGIC = "0x1626ba7e";

/**
 * The ERC-6492 suffix a counterfactual wallet appends to prove it *would* accept the signature
 * once deployed. `0x6492…6492`, 32 bytes, chosen so it cannot collide with a real signature tail.
 */
export const ERC6492_MAGIC =
  "0x6492649264926492649264926492649264926492649264926492649264926492" as const;

export const erc1271Abi = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

export interface SignatureReader {
  /** Deployed bytecode at `address`, or `0x` when nothing is deployed there. */
  code(address: Hex): Promise<Hex>;
  /**
   * ERC-1271 `isValidSignature`, returning the raw call data.
   *
   * `undefined` means the call *reverted* — a definitive "no" from the wallet. Anything that
   * merely failed to reach the chain must throw instead; see `signatureReader`.
   */
  isValidSignature(address: Hex, digest: Hex, signature: Hex): Promise<Hex | undefined>;
  /**
   * Optional ERC-6492 validation for an account that is not deployed yet.
   *
   * This cannot be an ordinary `eth_call`: the wallet does not exist, so the validator has to be
   * deployed inside the call itself. viem's `verifyHash` does exactly that, which is why this is
   * a separate capability rather than something reconstructed here from `code` and
   * `isValidSignature`. Absent, a counterfactual signature is refused with an explicit Problem
   * rather than silently reported invalid.
   */
  verifyPredeploy?(address: Hex, digest: Hex, signature: Hex): Promise<boolean>;
}

/** The subset of a viem `PublicClient` this needs. Structural, so no viem type is imported. */
export interface SignatureClient {
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  call(args: { to: Hex; data: Hex }): Promise<{ data?: Hex | undefined }>;
  verifyHash?(args: { address: Hex; hash: Hex; signature: Hex }): Promise<boolean>;
}

/**
 * viem error names that mean "the EVM ran this and it reverted".
 *
 * The distinction this set draws is the whole point of the port. A revert is the wallet saying
 * no; an unreachable RPC is us not knowing. Collapsing the two would tell a user with a perfectly
 * valid signature that their signature is invalid, and the only action that message suggests is
 * to sign again — which is precisely what the submission route already tells them not to do.
 * So anything not recognised here is treated as an outage and surfaces as a 503.
 */
const REVERT_ERRORS = new Set([
  "ContractFunctionRevertedError",
  "ExecutionRevertedError",
  "RawContractError",
  "AbiDecodingZeroDataError",
]);

/**
 * Did this failure come from the EVM rather than from the network?
 *
 * Walks `cause` with a depth bound: viem nests three or four errors deep and a badly behaved
 * transport could in principle produce a cycle. `code === 3` is the JSON-RPC code geth and every
 * Base endpoint use for "execution reverted"; `-32000` is deliberately *not* included, because
 * providers also use it for "header not found" and rate limiting, which are outages.
 */
export function isRevert(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    const { name, code } = current as { name?: unknown; code?: unknown };
    if (typeof name === "string" && REVERT_ERRORS.has(name)) return true;
    if (code === 3) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Is this the ERC-1271 acceptance value?
 *
 * The return of an `eth_call` is ABI-encoded, so a compliant wallet answers with 32 bytes whose
 * first four are the magic and whose remaining 28 are padding. Some wallets return the bare four
 * bytes instead. Both are accepted by looking only at the leading four; a shorter answer, an
 * empty answer (which is what an address with no code returns) and any other value are all "no".
 */
export function isMagicValue(data: Hex | undefined): boolean {
  if (!data || data.length < 10) return false;
  return data.slice(0, 10).toLowerCase() === ERC1271_MAGIC;
}

/** Does this signature carry the ERC-6492 counterfactual wrapper? */
export function isErc6492(signature: Hex): boolean {
  return signature.length > 66 && signature.toLowerCase().endsWith(ERC6492_MAGIC.slice(2));
}

/**
 * Adapt a viem public client to the port.
 *
 * Nothing here logs, and no upstream error object is ever attached to the Problem it raises. A
 * viem `CallExecutionError` stringifies the full request — the RPC URL with whatever API key is
 * embedded in it, plus the calldata, which on this path contains the user's signature.
 */
export function signatureReader(client: SignatureClient): SignatureReader {
  const unavailable = () =>
    Problem.unavailable("The wallet's signature could not be checked onchain right now.");
  // Captured once so the optional capability is narrowed here rather than at every call, and so
  // a client that grows the method later cannot half-satisfy the port.
  const verifyHash = client.verifyHash?.bind(client);
  return {
    async code(address) {
      try {
        return (await client.getCode({ address })) ?? "0x";
      } catch {
        throw unavailable();
      }
    },
    async isValidSignature(address, digest, signature) {
      const data = encodeFunctionData({
        abi: erc1271Abi,
        functionName: "isValidSignature",
        args: [digest, signature],
      });
      try {
        return (await client.call({ to: address, data })).data;
      } catch (error) {
        if (isRevert(error)) return undefined;
        throw unavailable();
      }
    },
    ...(verifyHash
      ? {
          verifyPredeploy: async (address: Hex, hash: Hex, signature: Hex): Promise<boolean> => {
            try {
              // `verifyHash` deploys the ERC-6492 validator inside the call, so a *reverting*
              // validation and an unreachable node are indistinguishable from out here. viem
              // already returns false for the former, so anything that throws is the latter.
              return await verifyHash({ address, hash, signature });
            } catch {
              throw unavailable();
            }
          },
        }
      : {}),
  };
}
