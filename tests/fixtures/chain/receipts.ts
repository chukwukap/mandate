import type { Hex } from "../../../packages/contracts/src/index.js";
import { assetOf, USDC } from "./catalogue.js";
import { ACCOUNTS } from "./erc20.js";

/**
 * Recorded transaction receipts: confirmed, reverted, and the several shapes of "not yet".
 *
 * A receipt's `status` is not the answer on its own. The worker treats a transaction as
 * settled only when the receipt is in the canonical chain, buried under enough confirmations,
 * AND its Transfer logs prove the value it was supposed to move actually moved to the intended
 * recipient. Each of those three can fail independently while `status` still says success, so
 * every one of them has a fixture here:
 *
 *   - `swap-underfilled`  — success, but the user received less than the signed floor.
 *   - `fund-to-stranger`  — success, but the value went somewhere else entirely.
 *   - `fund-reorged`      — success, in a block that is no longer canonical.
 *   - `swap-unconfirmed`  — success, one block deep, still reorg-able.
 *
 * Reading any of those as "confirmed" loses real money quietly, which is why they are here
 * rather than only the happy path and a revert.
 */

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC: Hex =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Confirmations the worker fixture assumes. Base produces a block every ~2s. */
export const CONFIRMATIONS = 3;

export type RecordedLog = {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
};

export type RecordedReceipt = {
  readonly hash: Hex;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: number;
  readonly from: Hex;
  readonly to: Hex;
  readonly gasUsed: bigint;
  readonly logs: readonly RecordedLog[];
};

export type ReceiptFixture = {
  readonly id: string;
  /** Which leg of the order lifecycle produced it. */
  readonly leg: "fund" | "approve" | "swap" | "reset" | "refund";
  readonly hash: Hex;
  /** Null when the transaction is not mined: the node has no receipt to return. */
  readonly receipt: RecordedReceipt | null;
  /** Nonce this transaction was signed with. */
  readonly nonce: number;
  /**
   * The signer's nonce at `latest`. Greater than `nonce` with no receipt means SOMETHING
   * else took this slot — a replacement, or a transaction this process did not sign. That is
   * ambiguous, never "confirmed", and inferring success from a spent nonce is exactly the bug.
   */
  readonly signerNonce: number;
  /** Head of the chain when observed. Confirmations are `head - blockNumber + 1`. */
  readonly chainHead: bigint;
  /**
   * The block hash currently at `receipt.blockNumber`. Differs from `receipt.blockHash` after
   * a reorg, which is the only way to notice that a settled receipt has been unsettled.
   */
  readonly canonicalBlockHash: Hex | null;
  readonly note: string;
};

const AAPL = assetOf("AAPLc");

/** Left-pad an address into a 32-byte topic. */
function topicAddress(address: Hex): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** A uint256 as one 32-byte ABI word. */
function word(value: bigint): Hex {
  if (value < 0n) throw new Error("A Transfer value cannot be negative");
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function transferLog(params: {
  token: Hex;
  from: Hex;
  to: Hex;
  value: bigint;
}): RecordedLog {
  return {
    address: params.token,
    topics: [TRANSFER_TOPIC, topicAddress(params.from), topicAddress(params.to)],
    data: word(params.value),
  };
}

export type Transfer = { token: Hex; from: Hex; to: Hex; value: bigint };

/**
 * Decode one log as a Transfer, or null.
 *
 * Null rather than throw: a swap receipt carries Swap, Sync and Approval logs from several
 * contracts, and a decoder that threw on the first one it did not recognise would make every
 * real receipt unreadable. Anything that is not an ERC20 Transfer is simply not evidence.
 */
export function decodeTransfer(log: RecordedLog): Transfer | null {
  const [topic0, from, to] = log.topics;
  if (topic0?.toLowerCase() !== TRANSFER_TOPIC || from === undefined || to === undefined)
    return null;
  if (log.topics.length !== 3 || from.length !== 66 || to.length !== 66) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  return {
    token: log.address,
    from: `0x${from.slice(26)}`,
    to: `0x${to.slice(26)}`,
    value: BigInt(log.data),
  };
}

/**
 * Total of one token credited to one recipient by a receipt.
 *
 * Summed, not taken from the first match: a swap routes through the pool and can credit the
 * recipient in more than one log, and reading only the first understates the fill. When `from`
 * is given, only transfers out of that address count — a fund leg must prove the USDC came
 * from the user's own account, not from whatever else happened to move in the same block.
 */
export function creditedTo(
  receipt: RecordedReceipt,
  params: { token: Hex; recipient: Hex; from?: Hex },
): bigint {
  let total = 0n;
  for (const log of receipt.logs) {
    const transfer = decodeTransfer(log);
    if (!transfer) continue;
    if (transfer.token.toLowerCase() !== params.token.toLowerCase()) continue;
    if (transfer.to.toLowerCase() !== params.recipient.toLowerCase()) continue;
    if (params.from && transfer.from.toLowerCase() !== params.from.toLowerCase()) continue;
    total += transfer.value;
  }
  return total;
}

/** Depth of a receipt, counting its own block. Zero when there is no receipt. */
export function confirmationsOf(fixture: ReceiptFixture): number {
  if (!fixture.receipt) return 0;
  return Number(fixture.chainHead - fixture.receipt.blockNumber + 1n);
}

/** True when the block that held this receipt is no longer the canonical one at that height. */
export function reorged(fixture: ReceiptFixture): boolean {
  if (!fixture.receipt || fixture.canonicalBlockHash === null) return false;
  return fixture.canonicalBlockHash !== fixture.receipt.blockHash;
}

// Historical receipt evidence remains readable after migration 0006. This address is
// fixture data only; new wallet executions never submit funding or refund legs.
const LEGACY_SPENDER = "0x2222222222222222222222222222222222222222" as const;

const HEAD = 41_000_000n;
const block = (offset: bigint): bigint => HEAD - offset;
const blockHash = (label: string): Hex => `0x${label.padEnd(64, "b")}`;

/** The order these receipts belong to: a 250 USDC buy of AAPLc filling at $320.22. */
export const ORDER = {
  amountInUsdc: 250_000_000n,
  amountOutShares: 78_071_325n,
  /** 50 bps under the quoted output. The floor the swap was signed with. */
  minOutShares: 77_680_968n,
  token: AAPL.token,
} as const;

function receipt(params: {
  hash: Hex;
  status?: "success" | "reverted";
  offset: bigint;
  from?: Hex;
  to: Hex;
  logs?: readonly RecordedLog[];
  blockLabel: string;
}): RecordedReceipt {
  return {
    hash: params.hash,
    status: params.status ?? "success",
    blockNumber: block(params.offset),
    blockHash: blockHash(params.blockLabel),
    transactionIndex: 7,
    from: params.from ?? LEGACY_SPENDER,
    to: params.to,
    gasUsed: 148_912n,
    logs: params.logs ?? [],
  };
}

export const RECEIPTS: readonly ReceiptFixture[] = [
  {
    id: "fund-confirmed",
    leg: "fund",
    hash: `0x${"a1".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"a1".repeat(32)}`,
      offset: 6n,
      to: LEGACY_SPENDER,
      blockLabel: "0xfund",
      logs: [
        transferLog({
          token: USDC,
          from: ACCOUNTS.user,
          to: LEGACY_SPENDER,
          value: ORDER.amountInUsdc,
        }),
      ],
    }),
    nonce: 41,
    signerNonce: 42,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xfund"),
    note: "The happy fund: exactly the authorised USDC, from the user's account, seven blocks deep.",
  },
  {
    id: "approve-confirmed",
    leg: "approve",
    hash: `0x${"a2".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"a2".repeat(32)}`,
      offset: 5n,
      to: USDC,
      blockLabel: "0xapprove",
    }),
    nonce: 42,
    signerNonce: 43,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xapprove"),
    note: "An approval moves nothing, so it carries no Transfer evidence. A leg with no evidence must still confirm on status alone.",
  },
  {
    id: "swap-confirmed",
    leg: "swap",
    hash: `0x${"a3".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"a3".repeat(32)}`,
      offset: 4n,
      to: LEGACY_SPENDER,
      blockLabel: "0xswap",
      logs: [
        transferLog({
          token: USDC,
          from: LEGACY_SPENDER,
          to: ACCOUNTS.stranger,
          value: ORDER.amountInUsdc,
        }),
        transferLog({
          token: ORDER.token,
          from: ACCOUNTS.stranger,
          to: ACCOUNTS.user,
          value: ORDER.amountOutShares,
        }),
      ],
    }),
    nonce: 43,
    signerNonce: 44,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xswap"),
    note: "The fill lands above the signed floor and goes to the user, not the spender. The pool leg is the 'stranger' address.",
  },
  {
    id: "swap-underfilled",
    leg: "swap",
    hash: `0x${"a4".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"a4".repeat(32)}`,
      offset: 4n,
      to: LEGACY_SPENDER,
      blockLabel: "0xunder",
      logs: [
        transferLog({
          token: ORDER.token,
          from: ACCOUNTS.stranger,
          to: ACCOUNTS.user,
          value: 77_290_611n,
        }),
      ],
    }),
    nonce: 43,
    signerNonce: 44,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xunder"),
    note: "status: success, and still wrong — 100 bps under the signed floor. A router that filled below amountOutMinimum is not a router this system trusts.",
  },
  {
    id: "fund-to-stranger",
    leg: "fund",
    hash: `0x${"a5".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"a5".repeat(32)}`,
      offset: 6n,
      to: LEGACY_SPENDER,
      blockLabel: "0xwrong",
      logs: [
        transferLog({
          token: USDC,
          from: ACCOUNTS.user,
          to: ACCOUNTS.stranger,
          value: ORDER.amountInUsdc,
        }),
      ],
    }),
    nonce: 41,
    signerNonce: 42,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xwrong"),
    note: "A successful transaction that credited the wrong address. Matching on token and amount alone would call this funded.",
  },
  {
    id: "swap-reverted",
    leg: "swap",
    hash: `0x${"a6".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"a6".repeat(32)}`,
      status: "reverted",
      offset: 4n,
      to: LEGACY_SPENDER,
      blockLabel: "0xrevert",
    }),
    nonce: 43,
    signerNonce: 44,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xrevert"),
    note: "A reverted swap after a confirmed fund: the USDC is sitting in the spender wallet and the order needs a reset-and-refund, not a retry.",
  },
  {
    id: "fund-pending",
    leg: "fund",
    hash: `0x${"a7".repeat(32)}`,
    receipt: null,
    nonce: 41,
    signerNonce: 41,
    chainHead: HEAD,
    canonicalBlockHash: null,
    note: "No receipt and the nonce is unspent: genuinely still in the mempool. Rebroadcast, do not re-sign.",
  },
  {
    id: "fund-replaced",
    leg: "fund",
    hash: `0x${"a8".repeat(32)}`,
    receipt: null,
    nonce: 41,
    signerNonce: 43,
    chainHead: HEAD,
    canonicalBlockHash: null,
    note: "No receipt, but the nonce is spent by something else. Ambiguous — a spent nonce is not evidence that THIS transaction landed.",
  },
  {
    id: "swap-unconfirmed",
    leg: "swap",
    hash: `0x${"a9".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"a9".repeat(32)}`,
      offset: 0n,
      to: LEGACY_SPENDER,
      blockLabel: "0xhead",
      logs: [
        transferLog({
          token: ORDER.token,
          from: ACCOUNTS.stranger,
          to: ACCOUNTS.user,
          value: ORDER.amountOutShares,
        }),
      ],
    }),
    nonce: 43,
    signerNonce: 44,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xhead"),
    note: "Mined in the head block: one confirmation, below the bar. Settled-looking and still reorg-able.",
  },
  {
    id: "fund-reorged",
    leg: "fund",
    hash: `0x${"aa".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"aa".repeat(32)}`,
      offset: 6n,
      to: LEGACY_SPENDER,
      blockLabel: "0xorphan",
      logs: [
        transferLog({
          token: USDC,
          from: ACCOUNTS.user,
          to: LEGACY_SPENDER,
          value: ORDER.amountInUsdc,
        }),
      ],
    }),
    nonce: 41,
    signerNonce: 42,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xcanon"),
    note: "The receipt still decodes, but its block is orphaned. Only comparing the block hash at that height catches it.",
  },
  {
    id: "refund-confirmed",
    leg: "refund",
    hash: `0x${"ab".repeat(32)}`,
    receipt: receipt({
      hash: `0x${"ab".repeat(32)}`,
      offset: 3n,
      to: USDC,
      blockLabel: "0xrefund",
      logs: [
        transferLog({
          token: USDC,
          from: LEGACY_SPENDER,
          to: ACCOUNTS.user,
          value: ORDER.amountInUsdc,
        }),
      ],
    }),
    nonce: 45,
    signerNonce: 46,
    chainHead: HEAD,
    canonicalBlockHash: blockHash("0xrefund"),
    note: "The input returned intact after a failed swap. Exactly the amount, back to the account it came from.",
  },
];

export function receiptOf(id: string): ReceiptFixture {
  const fixture = RECEIPTS.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`No receipt fixture ${id}`);
  return fixture;
}

/** Synthetic direct-wallet variant of the historical receipt scenarios. */
export function directReceiptOf(id: string): ReceiptFixture {
  const fixture = receiptOf(id);
  if (fixture.leg !== "approve" && fixture.leg !== "swap")
    throw new Error(`Direct wallets do not submit ${fixture.leg}`);
  if (!fixture.receipt) return fixture;
  return {
    ...fixture,
    receipt: {
      ...fixture.receipt,
      from: ACCOUNTS.user,
      logs: fixture.receipt.logs.map((log) => ({
        ...log,
        topics: log.topics.map((topic, index) =>
          index === 1 && topic === topicAddress(LEGACY_SPENDER)
            ? topicAddress(ACCOUNTS.user)
            : topic,
        ),
      })),
    },
  };
}
