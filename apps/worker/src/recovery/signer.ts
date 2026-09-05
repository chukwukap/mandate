import type { Hex } from "@mandate/contracts";
import { SPEND_MANAGER, USDC } from "@mandate/evm";
import {
  decodeErrorResult,
  decodeFunctionData,
  erc20Abi,
  numberToHex,
  parseAbi,
  type PublicClient,
  type Transport,
} from "viem";
import type { base } from "viem/chains";
import { ROUTER } from "../chain.js";
import type { KnownCall, LocatedTransaction, NonceState, RevertVerdict } from "./types.js";

/**
 * Blocks searched back from the head by default: 21,600 ≈ 12 hours at Base's 2 s blocks.
 * Deeper than the 30-minute receipt timeout by a wide margin, shallow enough that a
 * `getTransactionCount` binary search costs ~15 probes rather than an unbounded walk.
 * There is no configuration knob for this yet; see the report's needsFromOthers.
 */
const DEFAULT_LOOKBACK = 21_600;

/**
 * Blocks read whole when historical STATE is unavailable. Base's public op-geth prunes
 * state past ~128 blocks and answers `eth_getTransactionCount` at an older block with a
 * missing-trie-node error, but block BODIES are always served. 128 blocks ≈ 4 min 16 s,
 * which covers the realistic "the process died seconds after broadcast" window.
 */
const DEFAULT_SCAN = 128;

/** Standard ABI error selectors. Nothing here is guessed from a contract's source. */
const standardErrors = parseAbi(["error Error(string)", "error Panic(uint256)"]);

/** Defined by the Solidity documentation, not inferred from any deployment. */
const PANIC: Record<string, string> = {
  "0": "generic compiler panic",
  "1": "assert(false)",
  "17": "arithmetic overflow or underflow",
  "18": "division or modulo by zero",
  "33": "invalid enum conversion",
  "34": "invalid storage byte array encoding",
  "49": "pop on an empty array",
  "50": "array index out of bounds",
  "65": "excessive memory allocation",
  "81": "call to an uninitialised internal function",
};

const spendAbi = parseAbi([
  "struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }",
  "function spend(SpendPermission permission, uint160 value)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

const HEX = /^0x[0-9a-fA-F]*$/;

function same(a: string | null | undefined, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Bound and de-fang any string that came from chain data before it can reach a log line or
 * `executions.reason`, which the API returns to users. Revert payloads are attacker-chosen
 * bytes from an arbitrary contract: a decoded `Error(string)` can carry newlines, ANSI
 * escapes or megabytes of padding. Enforced here at construction rather than left to
 * pino's key-name redaction, which only knows about field names.
 */
export function sanitize(text: string, limit = 200) {
  const flat = text.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Walk an error's `cause` chain for revert data without depending on viem's class shapes. */
function revertData(error: unknown): Hex | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = (current as { data?: unknown }).data;
    for (const candidate of [value, (value as { data?: unknown } | undefined)?.data])
      if (typeof candidate === "string" && HEX.test(candidate) && candidate.length > 2)
        return candidate as Hex;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Everything that has to ask the chain about the spender key.
 *
 * This class reads only. It holds no wallet, no private key and no signing method, so no
 * amount of misuse from a caller can make it originate a transaction.
 */
export class SignerHistory {
  /**
   * Tri-state on purpose. `eth_getTransactionBySenderAndNonce` is a Reth/Erigon method that
   * Base's op-geth does not implement; probing it once is cheap and probing it on every
   * recovery pass is noise. `false` is sticky for the life of the process.
   */
  private senderNonceRpc: boolean | undefined;

  constructor(
    private readonly client: PublicClient<Transport, typeof base>,
    private readonly maxLookbackBlocks: number = DEFAULT_LOOKBACK,
    private readonly maxScanBlocks: number = DEFAULT_SCAN,
  ) {}

  /**
   * Latest and pending nonce for the key. Returns null rather than throwing: an RPC outage
   * during recovery must degrade to "unknown", never to "the signer is idle".
   */
  async nonceState(signer: Hex): Promise<NonceState | null> {
    try {
      const [latest, pending, blockNumber] = await Promise.all([
        this.client.getTransactionCount({ address: signer, blockTag: "latest" }),
        this.client.getTransactionCount({ address: signer, blockTag: "pending" }),
        this.client.getBlockNumber({ cacheTime: 0 }),
      ]);
      return { signer, latest, pending, blockNumber };
    } catch {
      return null;
    }
  }

  /**
   * Find the transaction that consumed `nonce` for `signer`.
   *
   * Three strategies, cheapest first, each degrading to the next rather than to a wrong
   * answer. Every failure resolves to `unavailable`, NEVER to `not-consumed`: reporting a
   * pruned-archive error as "the nonce is free" would tell an operator the key is idle
   * while a funding transaction is in flight, which is the exact mistake that turns a
   * recoverable incident into a double spend.
   */
  async locate(signer: Hex, nonce: number): Promise<LocatedTransaction> {
    let probes = 0;
    if (this.senderNonceRpc !== false) {
      probes += 1;
      try {
        // Not in viem's typed RPC schema, so the request goes through untyped.
        const request = this.client.request as unknown as (args: {
          method: string;
          params: unknown[];
        }) => Promise<unknown>;
        const found = await request({
          method: "eth_getTransactionBySenderAndNonce",
          params: [signer, numberToHex(nonce)],
        });
        this.senderNonceRpc = true;
        // A null answer is not trusted as "free": fall through and prove it from counts.
        if (found && typeof found === "object") {
          const hash = (found as { hash?: unknown }).hash;
          if (typeof hash === "string" && HEX.test(hash))
            return {
              found: true,
              hash: hash as Hex,
              nonce,
              blockNumber: BigInt((found as { blockNumber?: string }).blockNumber ?? "0x0"),
              call: this.identify({
                to: ((found as { to?: string }).to ?? null) as Hex | null,
                input: ((found as { input?: string }).input ?? "0x") as Hex,
              }),
              method: "sender-nonce-rpc",
              probes,
            };
        }
      } catch {
        this.senderNonceRpc = false;
      }
    }

    const counted = await this.countSearch(signer, nonce, probes);
    if (counted.found || counted.reason !== "unavailable") return counted;
    return this.blockScan(signer, nonce, counted.probes);
  }

  /**
   * Exponential widen from the head, then binary search.
   *
   * `getTransactionCount(block)` is monotonic in block number, so the transaction that
   * consumed `nonce` is in the first block whose count exceeds it. Widening from the head
   * first matters for two reasons: a transaction lost to a crash is usually seconds old, so
   * a recent hit costs ~5 probes instead of the ~15 a full binary search over 21,600 blocks
   * needs; and every probe stays as close to the head as possible, which is where a
   * state-pruning node can still answer.
   */
  private async countSearch(
    signer: Hex,
    nonce: number,
    startProbes: number,
  ): Promise<LocatedTransaction> {
    let probes = startProbes;
    const count = async (blockNumber: bigint) => {
      probes += 1;
      return this.client.getTransactionCount({ address: signer, blockNumber });
    };
    try {
      const head = await this.client.getBlockNumber({ cacheTime: 0 });
      probes += 1;
      if ((await count(head)) <= nonce) return { found: false, reason: "not-consumed", probes };
      const floor = head > BigInt(this.maxLookbackBlocks) ? head - BigInt(this.maxLookbackBlocks) : 0n;

      // Invariant to establish: count(lo) <= nonce < count(hi).
      let hi = head;
      let lo = head;
      for (let step = 1n; ; step *= 2n) {
        const candidate = head > step && head - step > floor ? head - step : floor;
        if ((await count(candidate)) <= nonce) {
          lo = candidate;
          break;
        }
        hi = candidate;
        if (candidate === floor)
          // Already consumed at the oldest block we are willing to look at.
          return { found: false, reason: "outside-lookback", probes };
      }
      while (hi - lo > 1n) {
        const mid = lo + (hi - lo) / 2n;
        if ((await count(mid)) > nonce) hi = mid;
        else lo = mid;
      }
      const block = await this.client.getBlock({ blockNumber: hi, includeTransactions: true });
      probes += 1;
      const match = block.transactions.find(
        (t) => typeof t !== "string" && same(t.from, signer) && t.nonce === nonce,
      );
      if (!match || typeof match === "string") return { found: false, reason: "not-in-block", probes };
      return {
        found: true,
        hash: match.hash,
        nonce,
        blockNumber: hi,
        call: this.identify({ to: match.to, input: match.input }),
        method: "count-search",
        probes,
      };
    } catch {
      // Missing trie node, rate limit, timeout: all indistinguishable and all "unknown".
      return { found: false, reason: "unavailable", probes };
    }
  }

  /**
   * Read whole blocks back from the head. Slower and shallower than the count search, but
   * it needs no historical state, so it is the only strategy that works against a pruned
   * public endpoint — the deployment this worker actually defaults to.
   */
  private async blockScan(
    signer: Hex,
    nonce: number,
    startProbes: number,
  ): Promise<LocatedTransaction> {
    let probes = startProbes;
    try {
      const head = await this.client.getBlockNumber({ cacheTime: 0 });
      probes += 1;
      for (let back = 0; back < this.maxScanBlocks; back += 1) {
        const blockNumber = head - BigInt(back);
        if (blockNumber < 0n) break;
        const block = await this.client.getBlock({ blockNumber, includeTransactions: true });
        probes += 1;
        for (const t of block.transactions) {
          if (typeof t === "string" || !same(t.from, signer) || t.nonce !== nonce) continue;
          return {
            found: true,
            hash: t.hash,
            nonce,
            blockNumber,
            call: this.identify({ to: t.to, input: t.input }),
            method: "block-scan",
            probes,
          };
        }
      }
      return { found: false, reason: "unavailable", probes };
    } catch {
      return { found: false, reason: "unavailable", probes };
    }
  }

  /**
   * Decode calldata into something an operator can read.
   *
   * This proves WHAT a transaction does, never WHO authorised it. A decoded
   * `permission-spend` at our nonce is not evidence the bytes were ours: recovery reports
   * it and stops rather than adopting it into the journal.
   */
  identify(input: { to: Hex | null; input: Hex }): KnownCall {
    const to = input.to;
    const data = input.input;
    const selector = data.length >= 10 ? data.slice(0, 10) : null;
    if (!to || !selector) return { kind: "unknown", to, selector };
    if (same(to, SPEND_MANAGER))
      try {
        const call = decodeFunctionData({ abi: spendAbi, data });
        if (call.functionName === "spend") {
          const [permission, value] = call.args;
          return {
            kind: "permission-spend",
            account: permission.account,
            spender: permission.spender,
            token: permission.token,
            value: value.toString(),
          };
        }
      } catch {
        /* Not a spend call; fall through to the generic answer. */
      }
    if (same(to, ROUTER))
      try {
        const call = decodeFunctionData({ abi: routerAbi, data });
        const [params] = call.args;
        return {
          kind: "router-swap",
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          tickSpacing: params.tickSpacing,
          recipient: params.recipient,
          amountIn: params.amountIn.toString(),
          amountOutMinimum: params.amountOutMinimum.toString(),
        };
      } catch {
        /* Not an exactInputSingle call. */
      }
    try {
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName === "approve")
        return { kind: "erc20-approve", token: to, spender: call.args[0], amount: call.args[1].toString() };
      if (call.functionName === "transfer")
        return { kind: "erc20-transfer", token: to, recipient: call.args[0], amount: call.args[1].toString() };
    } catch {
      /* Not an ERC-20 write. */
    }
    return { kind: "unknown", to, selector };
  }

  /**
   * Explain a reverted receipt.
   *
   * Two failure modes need separate treatment because re-simulation cannot express either:
   *
   * 1. OUT OF GAS. `eth_call` at the parent block runs with a generous gas cap, so it does
   *    not reproduce a transaction that burned its own limit. A receipt whose `gasUsed` is
   *    within 2% of the limit is conclusive on its own and is reported without simulating.
   * 2. INTRA-BLOCK ORDERING. Re-running at `blockNumber - 1` sees the state before the
   *    whole block, so a swap that failed `amountOutMinimum` because of a trade earlier in
   *    the SAME block will succeed in simulation. That success is itself the finding, and
   *    is reported as `state-dependent` rather than as "no revert".
   *
   * The result is labelled indicative in its type and must never gate an automatic action.
   */
  async revertReason(args: {
    from: Hex;
    to: Hex;
    data: Hex;
    blockNumber: bigint;
    gasUsed: bigint;
    gasLimit: bigint;
  }): Promise<RevertVerdict> {
    if (args.gasLimit > 0n && args.gasUsed * 100n >= args.gasLimit * 98n)
      return {
        kind: "out-of-gas",
        detail: sanitize(
          `Receipt burned ${args.gasUsed} of a ${args.gasLimit} gas limit; treat as out of gas.`,
        ),
        indicative: true,
      };
    if (args.blockNumber === 0n)
      return { kind: "unknown", detail: "No parent block to re-simulate against.", indicative: true };
    try {
      await this.client.call({
        account: args.from,
        to: args.to,
        data: args.data,
        blockNumber: args.blockNumber - 1n,
      });
      return {
        kind: "state-dependent",
        detail:
          "Re-simulation at the parent block succeeded; the revert depended on state produced earlier in the same block.",
        indicative: true,
      };
    } catch (error) {
      const data = revertData(error);
      if (!data) return { kind: "unknown", detail: "Revert produced no returndata.", indicative: true };
      try {
        const decoded = decodeErrorResult({ abi: standardErrors, data });
        if (decoded.errorName === "Error")
          return { kind: "error-string", detail: sanitize(String(decoded.args[0])), indicative: true };
        const code = String(decoded.args[0]);
        return {
          kind: "panic",
          detail: sanitize(`Panic(${code}): ${PANIC[code] ?? "unspecified panic code"}`),
          indicative: true,
        };
      } catch {
        // A custom error. Its signature is NOT guessed: inventing a human-readable name for
        // a selector attaches a confident wrong story to a money-losing failure, which is
        // strictly worse than four honest bytes an operator can look up.
        return {
          kind: "custom-selector",
          detail: sanitize(`Custom error selector ${data.slice(0, 10)} (signature not resolved).`),
          indicative: true,
        };
      }
    }
  }

  /** The USDC the spender actually holds, and what it has left approved to the router. */
  async spenderPosition(signer: Hex) {
    const read = async (functionName: "balanceOf" | "allowance") => {
      try {
        return functionName === "balanceOf"
          ? await this.client.readContract({
              address: USDC,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [signer],
            })
          : await this.client.readContract({
              address: USDC,
              abi: erc20Abi,
              functionName: "allowance",
              args: [signer, ROUTER],
            });
      } catch {
        return null;
      }
    };
    const [balance, routerAllowance] = await Promise.all([read("balanceOf"), read("allowance")]);
    return { balance, routerAllowance };
  }
}
