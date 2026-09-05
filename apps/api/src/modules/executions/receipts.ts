import type { Hex } from "@mandate/contracts";
import { createPublicClient, http, keccak256, toHex } from "viem";
import { base } from "viem/chains";
import { type GasCost, gasCost } from "./pricing.js";

/**
 * `keccak256("Transfer(address,address,uint256)")`. Computed rather than pasted so a typo in a
 * 32-byte literal cannot silently make every fill read as zero received.
 */
export const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

/**
 * The parts of a Base transaction receipt this module reads.
 *
 * Structural rather than viem's `TransactionReceipt` so a test can build one by hand: the real
 * type carries a dozen fields (logsBloom, cumulativeGasUsed, transactionIndex, …) that have no
 * bearing on what a user is told, and requiring them would make the tests describe viem
 * instead of describing settlement. A real viem Base receipt is assignable to this.
 */
export type SettlementReceipt = {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** OP-stack L1 data fee. Present on Base; `null` on a node that omits it. */
  l1Fee?: bigint | null | undefined;
  logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[];
};

export type Settlement = {
  status: "confirmed" | "reverted";
  block_number: string;
  /** Blocks including this one. 1 means "in the head block". */
  confirmations: number;
  gas_used: string;
  effective_gas_price_wei: string;
  gas: GasCost;
  /**
   * Raw integer sum of ERC-20 `Transfer`s of the expected token to the expected recipient in
   * this transaction, or null when the caller did not name a token and recipient to look for
   * (an `approve` or `reset` leg moves nothing).
   */
  received: string | null;
};

export type SettlementTarget = { token: string; recipient: string };

export type SettlementRequest = {
  hash: Hex;
  /** Omit for a leg that transfers nothing; `received` then reports null instead of "0". */
  expect?: SettlementTarget | undefined;
};

/**
 * The optional chain port. Absent, every fill reports `settlement: null` and an unverified
 * fill state — which is the honest answer, because without a receipt nothing here knows what
 * was actually received.
 */
export interface ReceiptReader {
  settlement(request: SettlementRequest): Promise<Settlement | null>;
}

/** A 32-byte topic holds a left-padded address in its low 20 bytes. */
function addressFromTopic(topic: Hex | undefined): string | null {
  return topic && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : null;
}

/**
 * Sums the value the recipient actually received and prices the gas.
 *
 * Transfer logs are decoded by hand rather than through `decodeEventLog` so that a malformed
 * log is skipped instead of throwing mid-sum. The three conditions are exactly the standard
 * ERC-20 event: emitted by the token itself, three topics (signature, from, to), and a
 * 32-byte non-indexed value. A token that indexes `value` would arrive with four topics and
 * an empty data field; it is skipped rather than guessed at, because crediting the wrong
 * number to a fill is worse than admitting the fill is unverified. Every B20 token in this
 * market emits the standard event.
 *
 * `head` is the current block number. Confirmations are reported, never enforced: the worker's
 * own `observe()` owns the confirmation policy that gates state transitions, and this read is
 * a report on what already happened.
 */
export function settlementFrom(
  receipt: SettlementReceipt,
  head: bigint,
  expect?: SettlementTarget | undefined,
): Settlement {
  let received: bigint | null = null;
  if (expect && receipt.status === "success") {
    received = 0n;
    const token = expect.token.toLowerCase();
    const recipient = expect.recipient.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== token) continue;
      if (log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) continue;
      if (addressFromTopic(log.topics[2]) !== recipient) continue;
      if (log.data.length !== 66) continue;
      received += BigInt(log.data);
    }
  }
  // A reverted transaction moved no tokens but still burned gas the executor paid for.
  if (expect && receipt.status === "reverted") received = 0n;
  return {
    status: receipt.status === "success" ? "confirmed" : "reverted",
    block_number: receipt.blockNumber.toString(),
    confirmations: Number(head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n),
    gas_used: receipt.gasUsed.toString(),
    effective_gas_price_wei: receipt.effectiveGasPrice.toString(),
    gas: gasCost(receipt.gasUsed, receipt.effectiveGasPrice, receipt.l1Fee ?? 0n),
    received: received === null ? null : received.toString(),
  };
}

/** The two RPC calls this module makes. Narrower than viem's client, and trivially fakeable. */
export interface ReceiptSource {
  getTransactionReceipt(args: { hash: Hex }): Promise<SettlementReceipt>;
  getBlockNumber(): Promise<bigint>;
}

export type ReceiptReaderOptions = {
  /** How long a decoded settlement is reused. Only affects the confirmation count. */
  ttlMs?: number;
  /** Hard cap on cached entries, so a crawler paging history cannot grow this without bound. */
  maxEntries?: number;
  /** Concurrent RPC reads allowed across all in-flight requests. */
  maxConcurrent?: number;
  /** Per-call deadline. A slow public node must not hold an HTTP request open. */
  deadlineMs?: number;
};

const DEFAULTS = { ttlMs: 60_000, maxEntries: 500, maxConcurrent: 6, deadlineMs: 2_500 };

/**
 * Reads settlement from Base, and fails by saying nothing rather than by throwing.
 *
 * Every failure path returns null: an unmined or pruned hash, a node that rate-limits us, a
 * timeout, a wrong-network endpoint. The durable record — what was intended, what was signed,
 * what the journal says — is already in the response by the time this is called, and a 503
 * would hide all of it behind an RPC that the docs warn is paced and rate-limited. Nothing is
 * logged from the failure either: viem transport errors carry the request URL, which for a
 * paid RPC endpoint is a credential.
 *
 * The cache is keyed by hash *and* target because the same transaction is asked about with
 * different expectations (the fund leg's USDC to the spender, the swap leg's shares to the
 * user). Caching by hash alone would answer one question with the other's number.
 */
export class BaseReceiptReader implements ReceiptReader {
  private readonly cache = new Map<string, { at: number; value: Settlement }>();
  private readonly inFlight = new Map<string, Promise<Settlement | null>>();
  private readonly options: Required<ReceiptReaderOptions>;
  private active = 0;

  constructor(
    private readonly source: ReceiptSource,
    options: ReceiptReaderOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Base mainnet over HTTP. The timeout is deliberately shorter than @mandate/evm's 5s reader:
   * this is a page render, not an execution decision, and a user waiting on their trade
   * history is better served by "unverified" than by a spinner.
   */
  static fromUrl(url: string, options: ReceiptReaderOptions = {}) {
    const client = createPublicClient({
      chain: base,
      transport: http(url, { timeout: 2_500, retryCount: 0, batch: { wait: 20, batchSize: 5 } }),
    });
    return new BaseReceiptReader(
      {
        getTransactionReceipt: ({ hash }) => client.getTransactionReceipt({ hash }),
        // cacheTime bounds how often a burst of detail reads re-asks for the head block.
        getBlockNumber: () => client.getBlockNumber({ cacheTime: 4_000 }),
      },
      options,
    );
  }

  async settlement(request: SettlementRequest): Promise<Settlement | null> {
    const key = `${request.hash.toLowerCase()}|${request.expect?.token.toLowerCase() ?? ""}|${request.expect?.recipient.toLowerCase() ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.options.ttlMs) return hit.value;
    // Two legs of the same order, or two tabs, must not become two RPC round trips.
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.active >= this.options.maxConcurrent) return null;
    this.active++;
    const pending = this.read(request)
      .then((value) => {
        // Only successes are cached. Caching a failure would keep a transient rate-limit
        // answer alive for a minute after the node recovered.
        if (value) this.remember(key, value);
        return value;
      })
      .finally(() => {
        this.active--;
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  private remember(key: string, value: Settlement) {
    if (this.cache.size >= this.options.maxEntries) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { at: Date.now(), value });
  }

  private async read(request: SettlementRequest): Promise<Settlement | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.options.deadlineMs);
    });
    // The catch is attached to `work` itself, not to the race. If the deadline wins first and
    // the RPC call rejects a second later, an unhandled rejection would take the process down
    // under Node's default policy — a slow node must never be able to kill the API.
    const work = Promise.all([
      this.source.getTransactionReceipt({ hash: request.hash }),
      this.source.getBlockNumber(),
    ])
      .then(([receipt, head]) => settlementFrom(receipt, head, request.expect))
      // Deliberately swallowed and never logged. See the class comment.
      .catch(() => null);
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
