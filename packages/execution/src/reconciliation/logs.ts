import type { Hex } from "@mandate/contracts";

/**
 * Reading token movements out of a receipt.
 *
 * Everything downstream of here — what was actually spent, what was actually received, what
 * price was actually paid — is derived from these logs and from nothing else. That is the
 * point of the module: the quote is a prediction, `amountOutMinimum` is a floor, and the
 * only record of what happened is the `Transfer` events the tokens themselves emitted.
 *
 * Decoded by hand rather than with an ABI decoder because `@mandate/execution` has no viem
 * dependency and should not gain one to read three fixed-width fields. The layout is fixed
 * by ERC-20 and has not changed since 2015: three topics — the event signature, the sender,
 * the recipient — and a single 32-byte word of data holding the value.
 */

/**
 * `keccak256("Transfer(address,address,uint256)")`.
 *
 * A constant, not a computed value: hashing it would mean pulling a keccak implementation
 * into this package for one string that is fixed forever. `test/reconciliation.test.ts`
 * pins it against the same digest transcribed independently from the ERC-20 specification,
 * and decodes fixtures through it. A typo therefore fails a test rather than silently
 * finding zero transfers in every receipt — which is the failure mode that matters, because
 * "no transfers found" reads as "nothing moved" everywhere it is consumed.
 */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Structurally satisfied by a viem `Log`, so a receipt can be passed straight through. */
export type LogRecord = {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
};

export type TransferEvent = {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
};

const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;

/** The low 20 bytes of a 32-byte topic, lowercased. */
function topicAddress(topic: string): string | null {
  if (!HEX_WORD.test(topic)) return null;
  return `0x${topic.slice(26)}`.toLowerCase();
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Every standard ERC-20 `Transfer` in a receipt.
 *
 * A malformed or non-standard log is SKIPPED, never thrown on. A receipt contains the logs
 * of every contract the transaction touched, including ones this system has never heard of,
 * and a decoder that throws on the first surprise would turn an unrelated third-party event
 * into a failure to reconcile our own settled trade.
 *
 * Only the three-topic form is accepted. A token that packs the value into a topic, or that
 * emits a two-topic `Transfer`, decodes to a different number under this layout — so it is
 * ignored rather than guessed at. Both tokens this system trades (USDC and the B20 equities)
 * are standard; a non-standard one would show up as a zero amount, which every caller here
 * treats as "did not happen" and refuses to settle on.
 */
export function transfers(logs: readonly LogRecord[]): TransferEvent[] {
  const found: TransferEvent[] = [];
  for (const log of logs) {
    const [signature, from, to] = log.topics;
    if (signature === undefined || !eq(signature, TRANSFER_TOPIC)) continue;
    if (log.topics.length !== 3 || from === undefined || to === undefined) continue;
    const sender = topicAddress(from);
    const recipient = topicAddress(to);
    if (sender === null || recipient === null) continue;
    // Exactly one word of data. A longer payload is not an ERC-20 Transfer.
    if (!HEX_WORD.test(log.data)) continue;
    found.push({
      token: log.address.toLowerCase(),
      from: sender,
      to: recipient,
      value: BigInt(log.data),
    });
  }
  return found;
}

export type TransferFilter = {
  readonly token: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
};

/**
 * Total value matching a filter, SUMMED.
 *
 * Summed rather than "first match" for a concrete reason: a Slipstream swap can emit more
 * than one transfer of the same token to the same address in one transaction, and a router
 * that sweeps a remainder emits a second one at the end. Taking the first would under-count
 * the fill and over-state the price paid; taking the largest would under-count it too. Only
 * the sum is the amount that moved.
 */
export function totalTransferred(logs: readonly LogRecord[], filter: TransferFilter): bigint {
  let total = 0n;
  for (const event of transfers(logs)) {
    if (!eq(event.token, filter.token)) continue;
    if (filter.from !== undefined && !eq(event.from, filter.from)) continue;
    if (filter.to !== undefined && !eq(event.to, filter.to)) continue;
    total += event.value;
  }
  return total;
}

/** What an address received of a token in this transaction. */
export function received(logs: readonly LogRecord[], token: string, to: string): bigint {
  return totalTransferred(logs, { token, to });
}

/** What an address sent of a token in this transaction. */
export function sent(logs: readonly LogRecord[], token: string, from: string): bigint {
  return totalTransferred(logs, { token, from });
}

/**
 * Received minus sent, for one address and one token.
 *
 * The number to use whenever an address appears on both sides of a transaction — which the
 * spender wallet does on the swap leg, paying USDC out and (on a sell) taking USDC back in.
 * Reading only the inbound side there would report a gross figure as a net one.
 */
export function netTransferred(logs: readonly LogRecord[], token: string, address: string): bigint {
  return received(logs, token, address) - sent(logs, token, address);
}

/** Narrowing helper for callers holding a `Hex` from elsewhere in the codebase. */
export function asAddress(value: string): Hex {
  return value.toLowerCase() as Hex;
}
