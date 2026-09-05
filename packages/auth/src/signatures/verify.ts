import { addressSchema, type Hex, Problem, signatureSchema } from "@mandate/contracts";
import { hashMessage, parseErc6492Signature, recoverAddress } from "viem";
import {
  assertSameAuthorization,
  parseAuthorization,
  type StrategyAuthorization,
  strategyAuthorizationHash,
} from "./authorization.js";
import { isErc6492, isMagicValue, type SignatureReader } from "./erc1271.js";

/**
 * How a signature was proved.
 *
 * Worth surfacing rather than collapsing to a boolean: `eoa` costs nothing and happens offline,
 * while the other two each cost an RPC round trip, and an operator staring at latency wants to
 * know which path a request took. It is also the honest answer to "is this account a smart
 * wallet", derived from what actually verified rather than from a separate `walletKind` guess.
 */
export type SignatureMethod = "eoa" | "erc1271" | "erc6492";

export type VerifiedSignature = {
  readonly account: Hex;
  /** The digest the signature was checked against. */
  readonly digest: Hex;
  readonly method: SignatureMethod;
};

export type DigestVerification = {
  readonly account: string;
  readonly digest: Hex;
  readonly signature: string;
  readonly reader: SignatureReader;
};

/**
 * Does `signature` authorise `digest` for `account`?
 *
 * Returns the method on success, `undefined` when the answer is a definitive no, and throws
 * `Problem.unavailable` when the chain could not be consulted. Those three outcomes are kept
 * apart on purpose: reporting an outage as "invalid" makes a user re-sign a signature that was
 * always fine, and reporting an invalid signature as an outage lets a bad one be retried forever.
 *
 * The order of attempts is cost-ordered and it is also correctness-ordered:
 *
 * 1. **ecrecover.** Free, offline, and covers every plain EOA. A signature that recovers to an
 *    address is proof of that address's key; it stays proof whether or not code is deployed
 *    there, so this needs no `getCode` first and is safe under EIP-7702 delegation.
 * 2. **ERC-1271.** Only reachable once ecrecover has failed, and only when there is code to ask.
 *    Base Account is a smart wallet, so this is the *normal* path for this product, not a corner.
 * 3. **ERC-6492.** A wallet that has not been deployed yet. See below.
 *
 * `reader` is required rather than optional. An optional one invites a caller to omit it and get
 * silent rejection of every smart-wallet user — a failure that looks exactly like a bad
 * signature. Callers that genuinely have no chain access should say so by calling
 * `verifyEoaDigest`.
 */
export async function verifyDigest(input: DigestVerification): Promise<SignatureMethod | undefined> {
  const account = requireAddress(input.account);
  const signature = asSignature(input.signature);
  // A malformed signature is not an error condition, it is an invalid signature. Anything that
  // is not an even-length hex string could never have come from a wallet.
  if (!signature) return undefined;

  // ERC-6492 wraps `(factory, factoryCalldata, innerSignature)` and appends the magic suffix.
  // `parseErc6492Signature` returns the signature untouched when the suffix is absent.
  const wrapped = isErc6492(signature);
  const inner = wrapped ? unwrapErc6492(signature) : signature;
  // Carrying the suffix is not the same as being an envelope. Anyone can append 32 bytes of magic
  // to junk, and viem then throws `PositionOutOfBoundsError` from inside `decodeAbiParameters`
  // rather than returning anything. Letting that escape would turn the cheapest possible bad
  // signature into a 500 and put a raw viem error — which stringifies the calldata — in front of
  // the logger. It is an invalid signature, and this module answers that the same way it does for
  // every other one.
  if (inner === undefined) return undefined;

  // Only ever attempted on an unwrapped signature. The inner half of a 6492 envelope is the
  // *owner key's* signature over the wallet's own replay-safe hash, so it recovers to an address
  // that is not the account and never should be compared to it.
  if (!wrapped && (await recoversTo(account, input.digest, signature))) return "eoa";

  const deployed = await isDeployed(input.reader, account);
  if (!deployed) {
    // Nothing deployed and no deployment plan attached: there is no contract that could accept
    // this, and ecrecover already said no.
    if (!wrapped) return undefined;
    if (!input.reader.verifyPredeploy)
      throw new Problem(
        409,
        "wallet-not-deployed",
        "Finish setting up your wallet",
        "This signature was made before your smart wallet was deployed. Complete a transaction with it, then try again.",
      );
    return (await input.reader.verifyPredeploy(account, input.digest, signature))
      ? "erc6492"
      : undefined;
  }

  // Deployed, so ERC-6492 says to discard the wrapper and ask the account directly. This is the
  // common case by the time the worker re-verifies: the account signed counterfactually at
  // submission and was deployed by the permission approval minutes later.
  const answer = await input.reader.isValidSignature(account, input.digest, inner);
  if (!isMagicValue(answer)) return undefined;
  return wrapped ? "erc6492" : "erc1271";
}

/**
 * The offline half, for callers with no chain access at all.
 *
 * Exported because it is honest about what it cannot do: it returns false for every smart
 * wallet, and a caller reaching for it is stating that it only ever deals with EOAs.
 */
export async function verifyEoaDigest(
  account: string,
  digest: Hex,
  signature: string,
): Promise<boolean> {
  const parsed = asSignature(signature);
  if (!parsed) return false;
  return recoversTo(requireAddress(account), digest, parsed);
}

/**
 * Verify a signature over the EIP-712 review card.
 *
 * `undefined` for a definitive no; throws for an outage or a malformed card. Callers that hold
 * both the signed and the executing card should use `authorizeExecution` instead.
 */
export async function verifyStrategyAuthorization(input: {
  readonly authorization: StrategyAuthorization;
  readonly signature: string;
  readonly reader: SignatureReader;
}): Promise<VerifiedSignature | undefined> {
  const card = parseAuthorization(input.authorization);
  const digest = strategyAuthorizationHash(input.authorization);
  const method = await verifyDigest({
    account: card.account,
    digest,
    signature: input.signature,
    reader: input.reader,
  });
  return method ? { account: card.account, digest, method } : undefined;
}

/**
 * The consent boundary, as one call.
 *
 * `signed` is the card recorded when the user signed. `executing` is the card rebuilt from the
 * rows that are about to run. Both must be identical, and the signature must cover it.
 *
 * The digest is taken from `executing`, not from `signed`, and that is deliberate rather than
 * arbitrary. `assertSameAuthorization` has already established they are equal, so the two digests
 * are the same value — but if that comparison ever had a hole, hashing the *executing* card means
 * the signature is still checked against what will actually run, and the hole becomes a rejected
 * request instead of an unauthorised trade.
 *
 * What this deliberately does not check is the signing deadline; see `signingDeadlinePassed`.
 */
export async function authorizeExecution(input: {
  readonly signed: StrategyAuthorization;
  readonly executing: StrategyAuthorization;
  readonly signature: string;
  readonly reader: SignatureReader;
}): Promise<VerifiedSignature> {
  assertSameAuthorization(input.signed, input.executing);
  const verified = await verifyStrategyAuthorization({
    authorization: input.executing,
    signature: input.signature,
    reader: input.reader,
  });
  if (!verified)
    throw new Problem(
      400,
      "invalid-signature",
      "Invalid signature",
      "Sign the exact saved review with its linked wallet.",
    );
  return verified;
}

/**
 * The same EOA / ERC-1271 / ERC-6492 pipeline over an EIP-191 `personal_sign` message.
 *
 * The live authorization path signs the plaintext `authorizationMessage` from
 * `@mandate/strategy`, and `ChainReader.verifyMessage` collapses every outcome — bad signature,
 * unreachable RPC, undeployed wallet — into one `false`. This is the drop-in that keeps those
 * apart, so the plaintext flow can be corrected without waiting for the frontend to move to
 * typed data.
 */
export async function verifyPersonalSignature(input: {
  readonly account: string;
  readonly message: string;
  readonly signature: string;
  readonly reader: SignatureReader;
}): Promise<VerifiedSignature | undefined> {
  const account = requireAddress(input.account);
  const digest = hashMessage(input.message);
  const method = await verifyDigest({
    account,
    digest,
    signature: input.signature,
    reader: input.reader,
  });
  return method ? { account, digest, method } : undefined;
}

/** Lowercased so every comparison in this module has one normal form. */
function requireAddress(value: string): Hex {
  const parsed = addressSchema.safeParse(value);
  if (!parsed.success)
    throw new Problem(
      400,
      "invalid-account",
      "Invalid account",
      "The strategy account is not an Ethereum address.",
    );
  return parsed.data.toLowerCase() as Hex;
}

/** Bounded and shape-checked with the same schema the routes accept on the wire. */
function asSignature(value: string): Hex | undefined {
  const parsed = signatureSchema.safeParse(value);
  return parsed.success ? (parsed.data as Hex) : undefined;
}

/**
 * ecrecover, with every failure treated as "not this address".
 *
 * `recoverAddress` throws on a signature it cannot parse — a 32-byte blob, a contract signature,
 * an out-of-range `s` — and none of those is an error the caller can act on; they all just mean
 * this is not an EOA signature for this digest, and the contract paths below still get their turn.
 */
async function recoversTo(account: Hex, digest: Hex, signature: Hex): Promise<boolean> {
  try {
    const recovered = await recoverAddress({ hash: digest, signature });
    return recovered.toLowerCase() === account;
  } catch {
    return false;
  }
}

/**
 * Peel the ERC-6492 envelope, or report that there was never one there.
 *
 * Separated out so the `decodeAbiParameters` failure has exactly one meaning at the call site.
 * A `catch` inline would have had to decide between rethrowing (a 500 on attacker-chosen input)
 * and swallowing, and only the caller knows that "not an envelope" is just another invalid
 * signature.
 */
function unwrapErc6492(signature: Hex): Hex | undefined {
  try {
    return parseErc6492Signature(signature).signature;
  } catch {
    return undefined;
  }
}

/** `0x` is what an address with no code returns; some nodes answer with an empty string. */
async function isDeployed(reader: SignatureReader, account: Hex): Promise<boolean> {
  const code = await reader.code(account);
  return typeof code === "string" && code.length > 2;
}
