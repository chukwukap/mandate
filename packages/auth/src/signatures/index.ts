/**
 * The consent boundary.
 *
 * A Mandate strategy is authorised once, in a wallet prompt, and then executed by a worker for as
 * long as it stays armed. Everything in this directory exists to keep one property true across
 * that gap: the artifact the user read and signed is the artifact that runs, byte for byte.
 *
 * Three pieces:
 *
 * - `authorization.ts` — the EIP-712 encoding of the review card, and the field-by-field
 *   comparison between the card that was signed and the card that would run.
 * - `erc1271.ts` — the single chain read the contract-wallet paths need, behind a port, with a
 *   revert (a definitive "no") kept distinct from an unreachable node (a 503).
 * - `verify.ts` — EOA, ERC-1271 and ERC-6492 verification, and `authorizeExecution`, which is the
 *   two halves put together.
 *
 * What is deliberately absent: anything that mints, stores or refreshes a credential. That is
 * `../sessions/`, and it defers to Privy. This module only ever checks a signature somebody else
 * produced.
 */

export type {
  NormalizedAuthorization,
  StrategyAuthorization,
} from "./authorization.js";
export {
  assertSameAuthorization,
  AUTHORIZATION_FIELDS,
  authorizationDifferences,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  EIP712_DOMAIN_TYPE,
  parseAuthorization,
  PRIMARY_TYPE,
  signingDeadlinePassed,
  strategyAuthorizationHash,
  strategyAuthorizationJson,
  strategyAuthorizationTypedData,
  strategyAuthorizationTypes,
} from "./authorization.js";
export type { SignatureClient, SignatureReader } from "./erc1271.js";
export {
  erc1271Abi,
  ERC1271_MAGIC,
  ERC6492_MAGIC,
  isErc6492,
  isMagicValue,
  isRevert,
  signatureReader,
} from "./erc1271.js";
export type { DigestVerification, SignatureMethod, VerifiedSignature } from "./verify.js";
export {
  authorizeExecution,
  verifyDigest,
  verifyEoaDigest,
  verifyPersonalSignature,
  verifyStrategyAuthorization,
} from "./verify.js";
