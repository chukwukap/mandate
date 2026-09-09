import { createHash } from "node:crypto";
import type { Hex } from "../../../packages/contracts/src/index.js";
import type { Leg } from "../../../packages/execution/src/lifecycle.js";
import type {
  ReceiptRecord,
  TransferEvidence,
} from "../../../packages/execution/src/reconciliation/index.js";
import type {
  JournalEntry,
  RecordedSubmission,
  SignedTransaction,
  SubmissionCall,
  SubmissionChain,
  SubmissionJournal,
  SubmissionRequest,
} from "../../../packages/execution/src/submission/index.js";
import { Submitter } from "../../../packages/execution/src/submission/index.js";
import {
  ACCOUNTS,
  CHAIN_ID,
  ORDER,
  type ReceiptFixture,
  SLIPSTREAM_SWAP_ROUTER,
  USDC,
} from "../../fixtures/chain/index.js";
import { directReceiptOf } from "../../fixtures/chain/receipts.js";

/**
 * The execution pipeline composed against a node that keeps state and a journal that enforces
 * the constraints `mandate_v2.transactions` enforces.
 *
 * `packages/execution/test` already proves each decision in isolation with stubs that answer a
 * scripted list. That leaves the properties that only exist once the pieces are joined and the
 * state persists between calls: that a nonce consumed by leg one is the nonce leg two plans
 * around, that resending identical bytes really is one transaction rather than a stub returning
 * a convenient answer, that a duplicated job loses at a UNIQUE index instead of at a `Set`, and
 * — the one this directory exists for — that a process killed between the durable write and the
 * broadcast recovers the transaction rather than duplicating or losing it.
 *
 * Nothing here opens a socket. The node is a state machine over recorded fixture receipts, and
 * every amount, address and log it produces comes from `tests/fixtures/chain`.
 *
 * Deep relative imports rather than `@mandate/*`: `tests/` has no `node_modules` of its own, so
 * a bare workspace specifier does not resolve from here.
 */

/**
 * Base's L2 execution price, in wei per gas.
 *
 * 0.005 gwei is the ordinary Base base fee, twenty times under the 0.1 gwei
 * `packages/execution/test/submission.test.ts` budgets against as a fee ceiling — a ceiling is
 * what a key must be able to afford, this is what a receipt actually charged. It is low on
 * purpose: it is what makes the L1 data fee the larger half of the bill below, which is the
 * asymmetry a cost function built from `gasUsed * gasPrice` alone gets wrong.
 */
export const EFFECTIVE_GAS_PRICE_WEI = 5_000_000n;

/**
 * The OP-stack L1 data fee one of these transactions pays to post its calldata, in wei.
 *
 * Not derived from `gasUsed` and not visible in it. 1.2e12 wei is an order of magnitude below
 * the flat `L1_FEE_ALLOWANCE_WEI` budget in `submission/gas.ts` — a budget is a ceiling, a
 * receipt is a measurement — and against the ~7.4e11 wei of L2 fee a 148,912-gas call costs at
 * the price above it is about 62% of the total. A reconciliation that ignores it under-reports
 * the operator's cost by roughly that much on every leg.
 */
export const L1_FEE_WEI = 1_200_000_000_000n;

/** The strategy account: origin of the input, recipient of the shares. */
export const ACCOUNT: Hex = ACCOUNTS.user;

/** One order, matching the receipt fixtures: a 250 USDC buy of AAPLc filling at $320.22. */
export const ORDER_ID = "order-aapl-1";
export const OWNER_ID = "user-1";

/**
 * A first block far enough below the fixtures' own height that a mined block number cannot
 * collide with one; the number itself carries no meaning beyond being a block.
 */
const START_BLOCK = 40_900_000n;

/** Confirmations the worker fixture assumes, mirrored so tests can bury a receipt exactly. */
export { CONFIRMATIONS } from "../../fixtures/chain/index.js";

/**
 * The calls each leg sends, as the pipeline sees them.
 *
 * `data` is opaque here on purpose. `Submitter` checks only that a call is well formed and then
 * treats the bytes as bytes: it never decodes calldata to decide what happened, because calldata
 * is what was asked for and the receipt's logs are what was done. Encoding real ABI arguments
 * would need viem, which cannot be imported from `tests/`, and would prove nothing this
 * directory is about. The `to` addresses are the real Base ones so a call that went to the wrong
 * contract is still visible.
 */
export const CALLS: Readonly<Record<Leg, SubmissionCall>> = {
  approve: { to: USDC, data: "0x095ea7b3" },
  swap: { to: SLIPSTREAM_SWAP_ROUTER, data: "0x04e45aaf" },
};

/** The request the worker would build for one leg of the order above. */
export function request(leg: Leg, overrides: Partial<SubmissionRequest> = {}): SubmissionRequest {
  return {
    executionId: ORDER_ID,
    userId: OWNER_ID,
    leg,
    signer: ACCOUNT,
    call: CALLS[leg],
    ...overrides,
  };
}

/**
 * The bytes a signature produces, as a pure function of everything that identifies them.
 *
 * The property the pipeline's whole safety argument rests on is that identical inputs produce
 * identical bytes and therefore an identical hash, so a resend is one transaction while a
 * re-sign is two. Production gets that from `keccak256(rawTransaction)`; SHA-256 gives the same
 * property without pulling a keccak implementation into `tests/`, and nothing here depends on
 * the digest matching a real chain's.
 */
function encodeTransaction(input: {
  chainId: number;
  signer: Hex;
  nonce: number;
  call: SubmissionCall;
}): Hex {
  const body = [
    input.chainId,
    input.signer.toLowerCase(),
    input.nonce,
    input.call.to.toLowerCase(),
    (input.call.value ?? 0n).toString(),
    input.call.data.toLowerCase(),
  ].join("|");
  return `0x02${Buffer.from(body, "utf8").toString("hex")}`;
}

function hashOf(raw: Hex): Hex {
  return `0x${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * A JSON-RPC revert, in the shape a client actually surfaces one.
 *
 * Error code 3 with ABI-encoded `Error(string)` returndata is what an `eth_call` against a
 * reverting contract produces, and it is the only shape `classifySimulationFailure` may read as
 * "the EVM said no". Built here rather than hand-written so the reason a test names is the
 * reason the pipeline decodes.
 */
function revertError(reason: string): { code: number; message: string; data: string } {
  const hex = Buffer.from(reason, "utf8").toString("hex");
  const offset = 32n.toString(16).padStart(64, "0");
  const length = BigInt(Buffer.byteLength(reason)).toString(16).padStart(64, "0");
  return {
    code: 3,
    message: "execution reverted",
    data: `0x08c379a0${offset}${length}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`,
  };
}

/**
 * A recorded fixture receipt, re-stamped onto the transaction that actually mined.
 *
 * Two fields are added rather than taken from the fixture: `effectiveGasPrice` and `l1Fee`, which
 * `RecordedReceipt` does not carry and `ReceiptRecord` needs. Everything that decides an outcome
 * — status, logs, the addresses and amounts inside them — is the fixture's, so a test asserting
 * on a fill is asserting on recorded Base data and not on a number this file chose.
 */
function receiptRecord(
  fixture: ReceiptFixture,
  stamp: { transactionHash: Hex; blockNumber: bigint; blockHash: Hex },
): ReceiptRecord {
  const recorded = fixture.receipt;
  if (!recorded) throw new Error(`Receipt fixture ${fixture.id} has no receipt to mine`);
  return {
    transactionHash: stamp.transactionHash,
    blockNumber: stamp.blockNumber,
    blockHash: stamp.blockHash,
    status: recorded.status,
    gasUsed: recorded.gasUsed,
    effectiveGasPrice: EFFECTIVE_GAS_PRICE_WEI,
    l1Fee: L1_FEE_WEI,
    logs: recorded.logs,
  };
}

/**
 * What the swap leg must prove: at least the signed floor, delivered to the user.
 *
 * `exact` is false for this one wherever it is used. A swap's output is whatever the pool paid;
 * it is bounded below by `amountOutMinimum` and has no upper bound, so demanding equality would
 * report every favourable fill as ambiguous.
 */
export const SWAP_EVIDENCE: TransferEvidence = {
  token: ORDER.token,
  recipient: ACCOUNT,
  amount: ORDER.minOutShares.toString(),
};

type Pending = {
  readonly hash: Hex;
  readonly nonce: number;
  readonly raw: Hex;
  readonly signer: Hex;
};

type Mined = Pending & { readonly receipt: ReceiptRecord; readonly fixture: string };

export type NodeOptions = {
  readonly chainId?: number;
  /** Native balance of the spender, in wei. Defaults to 0.05 ETH: plenty for five legs. */
  readonly balanceWei?: bigint;
  readonly maxFeePerGas?: bigint;
  /** Nonces this key had already consumed before the test started. */
  readonly baseNonce?: number;
};

/**
 * A node, as far as the submission pipeline can tell.
 *
 * It keeps the two things a stub cannot: a mempool and a chain. That is what makes the
 * interesting assertions possible — "the same bytes twice is one transaction" is a fact about
 * the pool, and "the nonce leg two plans is the one leg one consumed" is a fact about the chain.
 *
 * Its send semantics are the ones `SubmissionChain.send` documents and the ones geth actually
 * implements: identical bytes are accepted silently however many times they arrive, different
 * bytes at an occupied nonce are refused as underpriced, and a nonce already in a block is
 * refused as too low. A fake that accepted everything would let a double-send bug pass.
 */
export class FixtureNode implements SubmissionChain {
  /** Every signature this node ever produced. The count is the double-spend detector. */
  readonly signatures: SignedTransaction[] = [];
  /** Every `send` call, duplicates included. */
  readonly sends: Hex[] = [];
  /** Distinct bytes the node took into its pool. One per real transaction. */
  readonly accepted: Pending[] = [];
  /** Every simulation the pipeline asked for, in order, by the leg's `to` address. */
  readonly simulations: Hex[] = [];

  private readonly id: number;
  private readonly base: number;
  private readonly balanceWei: bigint;
  private readonly fee: bigint;
  private readonly pool: Pending[] = [];
  private readonly blocks: Mined[] = [];
  private readonly simulationFaults: (unknown | null)[] = [];
  private readonly sendFaults: (unknown | null)[] = [];
  private headBlock = START_BLOCK;

  constructor(options: NodeOptions = {}) {
    this.id = options.chainId ?? CHAIN_ID;
    this.base = options.baseNonce ?? 0;
    this.balanceWei = options.balanceWei ?? 50_000_000_000_000_000n;
    this.fee = options.maxFeePerGas ?? 100_000_000n;
  }

  /** The next simulation reverts with this reason. Queued, so a sequence can be scripted. */
  revertsNext(reason: string): this {
    this.simulationFaults.push(revertError(reason));
    return this;
  }

  /** The next simulation cannot be performed at all — a timeout, a rate limit, a 502. */
  unavailableNext(): this {
    this.simulationFaults.push(new Error("fetch failed"));
    return this;
  }

  /** The next broadcast fails on transport. The bytes stay journaled and unsent. */
  sendFailsNext(message: string): this {
    this.sendFaults.push(new Error(message));
    return this;
  }

  async chainId(): Promise<number> {
    return this.id;
  }

  async transactionCounts(signer: Hex): Promise<{ latest: number; pending: number }> {
    const mine = (entry: Pending) => entry.signer.toLowerCase() === signer.toLowerCase();
    const latest = this.base + this.blocks.filter(mine).length;
    return { latest, pending: latest + this.pool.filter(mine).length };
  }

  async simulate(input: { signer: Hex; call: SubmissionCall }): Promise<void> {
    this.simulations.push(input.call.to);
    const fault = this.simulationFaults.shift();
    if (fault) throw fault;
  }

  async balance(): Promise<bigint> {
    return this.balanceWei;
  }

  async maxFeePerGas(): Promise<bigint> {
    return this.fee;
  }

  async sign(input: {
    signer: Hex;
    call: SubmissionCall;
    nonce: number;
  }): Promise<SignedTransaction> {
    const rawTransaction = encodeTransaction({ chainId: this.id, ...input });
    const signed: SignedTransaction = {
      signer: input.signer,
      nonce: input.nonce,
      rawTransaction,
      hash: hashOf(rawTransaction),
    };
    this.signatures.push(signed);
    return signed;
  }

  async send(rawTransaction: Hex): Promise<void> {
    this.sends.push(rawTransaction);
    const fault = this.sendFaults.shift();
    if (fault) throw fault;
    const known = this.signatures.find((entry) => entry.rawTransaction === rawTransaction);
    // A node cannot decode bytes it has never seen signed here; nothing in these tests
    // produces any, so this is a broken test rather than a chain condition.
    if (!known) throw new Error("The node was handed bytes no signer in this test produced");
    const { latest } = await this.transactionCounts(known.signer);
    if (this.pool.some((entry) => entry.raw === rawTransaction)) return;
    if (this.blocks.some((entry) => entry.raw === rawTransaction))
      throw new Error("nonce too low: transaction already mined");
    if (known.nonce < latest) throw new Error("nonce too low");
    if (this.pool.some((entry) => entry.nonce === known.nonce))
      throw new Error("replacement transaction underpriced");
    const pending: Pending = {
      hash: known.hash,
      nonce: known.nonce,
      raw: rawTransaction,
      signer: known.signer,
    };
    this.pool.push(pending);
    this.accepted.push(pending);
  }

  /**
   * Mine the oldest pooled transaction with a recorded receipt.
   *
   * The test names which recorded outcome the chain produced — `swap-confirmed`,
   * `swap-reverted`, `swap-underfilled` — because the node cannot derive it: the bytes are
   * opaque and the fixtures are the record of what Base actually returns for this order.
   */
  mine(options: { as: string }): Mined {
    const pending = this.pool.shift();
    if (!pending) throw new Error("Nothing is in the pool to mine");
    this.headBlock += 1n;
    const receipt = receiptRecord(directReceiptOf(options.as), {
      transactionHash: pending.hash,
      blockNumber: this.headBlock,
      blockHash: `0x${this.headBlock.toString(16).padStart(64, "0")}`,
    });
    const mined: Mined = { ...pending, receipt, fixture: options.as };
    this.blocks.push(mined);
    return mined;
  }

  /** Advance the head without mining anything, so a receipt accrues confirmations. */
  advance(blocks: number): this {
    if (blocks < 0) throw new Error("Blocks only accrue forward");
    this.headBlock += BigInt(blocks);
    return this;
  }

  get head(): bigint {
    return this.headBlock;
  }

  /** How many DISTINCT transactions this key ever got into the pool at one nonce. */
  transactionsAtNonce(nonce: number): number {
    return this.accepted.filter((entry) => entry.nonce === nonce).length;
  }

  /** True while these exact bytes are sitting in the mempool, unmined. */
  pooled(hash: string): boolean {
    return this.pool.some((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
  }

  /** Every receipt this node holds, for a reconciliation pass that reads by journal hash. */
  receipts(): readonly ReceiptRecord[] {
    return this.blocks.map((entry) => entry.receipt);
  }

  /**
   * Block hash by height, which is what turns a receipt read into a canonicality check.
   *
   * Nothing here reorgs, so every height answers with the block that is still there. The
   * mapping exists so a reconciliation pass in these tests is built the same way the worker's
   * would be, rather than omitting the argument that catches an orphaned receipt.
   */
  canonicalBlockHashes(): ReadonlyMap<string, string> {
    return new Map(
      this.blocks.map((entry) => [entry.receipt.blockNumber.toString(), entry.receipt.blockHash]),
    );
  }
}

/**
 * `mandate_v2.transactions`, reduced to the two constraints that make double-spending
 * structurally impossible.
 *
 * UNIQUE (signer, nonce) and UNIQUE (execution_id, leg) are not conveniences: they are the
 * backstop for every case where two processes both believe they are the leader, and they live
 * in PostgreSQL precisely so a crashed process cannot take them with it. Reproducing them here
 * — rather than letting a fake accept every write — is what lets a duplicated job be tested at
 * all.
 */
export class MemoryJournal implements SubmissionJournal {
  readonly rows: JournalEntry[] = [];
  /** Owner per row. `JournalEntry` omits it; the table does not, and RLS keys on it. */
  readonly owners = new Map<string, string>();
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private failures = 0;
  private nextId = 1;

  /**
   * The next `record` fails the way a database does: no row, no exception the caller can fix.
   *
   * This is the crash that must be uneventful. The bytes exist only in the calling frame at that
   * moment, and the whole ordering argument is that they are therefore discarded rather than
   * broadcast — so a test needs to be able to produce it.
   */
  failNextRecord(): this {
    this.failures += 1;
    return this;
  }

  /**
   * Hold every `record` until `resume()`.
   *
   * The only way to build the interleaving that matters: two workers that have both signed and
   * neither committed. Without it a test's two "concurrent" writers are really sequential and
   * the second one finds the first one's row, which is a different property.
   */
  pause(): this {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    return this;
  }

  resume(): this {
    this.release?.();
    this.gate = null;
    this.release = null;
    return this;
  }

  async entries(signer: Hex): Promise<readonly JournalEntry[]> {
    const key = signer.toLowerCase();
    return this.rows.filter((row) => row.signer.toLowerCase() === key).map((row) => ({ ...row }));
  }

  async record(input: {
    executionId: string;
    userId: string;
    leg: Leg;
    signed: SignedTransaction;
  }): Promise<RecordedSubmission> {
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("deadlock detected");
    }
    const { signed } = input;
    if (
      this.rows.some(
        (row) =>
          row.signer.toLowerCase() === signed.signer.toLowerCase() && row.nonce === signed.nonce,
      )
    )
      throw new Error('duplicate key value violates unique constraint "signer_nonce"');
    if (this.rows.some((row) => row.executionId === input.executionId && row.leg === input.leg))
      throw new Error('duplicate key value violates unique constraint "execution_leg"');
    const row: JournalEntry = {
      id: `tx-${this.nextId++}`,
      executionId: input.executionId,
      leg: input.leg,
      signer: signed.signer,
      nonce: signed.nonce,
      hash: signed.hash,
      rawTransaction: signed.rawTransaction,
      status: "signed",
    };
    this.rows.push(row);
    this.owners.set(row.id, input.userId);
    return { ...row, recorded: true };
  }

  /**
   * What the lifecycle writes once a receipt has been read.
   *
   * Separate from `record` and deliberately so: the journal's `signed` state means "bytes exist
   * and may or may not have reached the chain", and only a settled receipt may move a row out of
   * it. Nothing in the submission pipeline calls this — it is the reconciliation half.
   */
  settle(hash: string, status: "confirmed" | "reverted"): this {
    const index = this.rows.findIndex((row) => row.hash.toLowerCase() === hash.toLowerCase());
    const row = this.rows[index];
    if (!row) throw new Error(`No journal row for ${hash}`);
    this.rows[index] = { ...row, status };
    return this;
  }

  find(leg: Leg): JournalEntry | undefined {
    return this.rows.find((row) => row.leg === leg);
  }
}

/**
 * Start a worker process over durable state.
 *
 * A `Submitter` holds nothing across a call that matters — its only state is the chain id it was
 * configured with — so this is also how a restart is modelled: drop the old one, build a new one
 * over the same journal and the same node, exactly as a supervisor restarting a crashed worker
 * would. Every test that says "crash" does this and nothing else, which is the point: if
 * recovery needed anything that was only in the dead process's memory, it would fail here.
 */
export function boot(node: FixtureNode, journal: MemoryJournal): Submitter {
  return new Submitter(node, journal);
}

/** A node and a journal that have never seen a transaction. */
export function freshChain(options: NodeOptions = {}): {
  node: FixtureNode;
  journal: MemoryJournal;
  worker: Submitter;
} {
  const node = new FixtureNode(options);
  const journal = new MemoryJournal();
  return { node, journal, worker: boot(node, journal) };
}
