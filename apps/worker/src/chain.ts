import { type EmbeddedWallet, PrivySigner } from "@mandate/auth";
import type { WorkerConfig } from "@mandate/config";
import type { Hex } from "@mandate/contracts";
import type { DraftRow, ExecutionRow, TransactionRow } from "@mandate/database";
import { BaseReader, USDC } from "@mandate/evm";
import {
  type Context,
  type Executor,
  type Leg,
  type Observation,
  type Observations,
  type Prepared,
  RecoveryRequired,
  type Snapshot,
  verifyCommitment,
} from "@mandate/execution";
import { evaluate, units, whole } from "@mandate/strategy";
import { Decimal } from "decimal.js";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  TransactionReceiptNotFoundError,
  type Transport,
} from "viem";
import { base } from "viem/chains";

const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });
export const ROUTER = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" as const;
const ORACLE_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as const;
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002" as const;
const abi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function getOracleParams(address token) view returns (uint256 multiplier,bool paused)",
  "function isPaused(uint8 feature) view returns (bool)",
  "function TRANSFER_RECEIVER_POLICY() view returns (bytes32)",
  "function policyId(bytes32 scope) view returns (uint64)",
  "function isAuthorized(uint64 policy,address account) view returns (bool)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

// Deliberately conservative session: fresh observations within regular US hours.
// Stale holiday/overnight closing prices cannot admit an order.
export function executionSession(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  return !["Sat", "Sun"].includes(get("weekday")) && minute >= 575 && minute < 955;
}
/**
 * How long an admitted intent may wait before its first leg is signed.
 *
 * Measured from admission, and admission fires every machine in a single pass, so every order
 * in a basket carries the same creation instant while they are signed one at a time. Sized to
 * let a full seven-asset basket through rather than to police price staleness: `guard`
 * re-evaluates the triggering condition against a fresh snapshot immediately before each leg,
 * and the swap re-quotes under the signed slippage cap, so a late order still cannot fill on a
 * condition that has stopped holding or at a price outside what was signed.
 */
const ORDER_DEADLINE_MS = 600_000;

export class WorkerChain implements Observations, Executor {
  readonly reader: BaseReader;
  readonly client;
  private readonly transport: Transport;
  /**
   * Signs from users' own Privy embedded wallets. This process holds no wallet key: each user
   * delegated their wallet to the app's signer once, and every signature is authorised with
   * that signer's key and checked by Privy against the delegation.
   */
  readonly signer: PrivySigner | undefined;
  constructor(
    private readonly config: WorkerConfig,
    injectedTransport?: Transport,
    signer?: PrivySigner,
  ) {
    this.transport =
      injectedTransport ??
      http(config.rpcUrl, {
        timeout: 5000,
        retryCount: 1,
        batch: { wait: 30, batchSize: 5 },
      });
    this.client = createPublicClient({ chain: base, transport: this.transport });
    this.reader = new BaseReader(this.client);
    this.signer =
      signer ?? (config.execute && config.privy ? new PrivySigner(config.privy) : undefined);
  }
  verifyMessage(account: Hex, message: string, signature: Hex) {
    return this.reader.verifyMessage(account, message, signature);
  }
  async snapshot(draft: DraftRow): Promise<Snapshot> {
    const feeds: Record<string, string> = {};
    const required = new Set(
      draft.envelope.assets.flatMap((a) => [`oracle:${a.symbol}`, `dex:${a.symbol}`]),
    );
    const market = await this.reader.market();
    for (const feed of market)
      if (required.has(feed.uri)) {
        if (feed.stale || feed.value === null) throw new Error("Missing market observation");
        feeds[feed.uri] = feed.value;
      }
    if (Object.keys(feeds).length !== required.size) throw new Error("Missing market feed");
    const cash = new Money(
      whole(
        await this.client.readContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [draft.account as Hex],
        }),
        6,
      ),
    );
    let equity = cash;
    const positions: Record<string, string> = {};
    for (const asset of draft.envelope.assets) {
      const balance = await this.client.readContract({
        address: asset.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [draft.account as Hex],
      });
      const held = whole(balance, asset.decimals);
      positions[asset.token.toLowerCase()] = held;
      const value = new Money(held).mul(feeds[`oracle:${asset.symbol}`] ?? "NaN");
      equity = equity.plus(value);
      // The same numbers sizing has always used, now readable from a condition too. Valued at
      // the oracle rather than the pool: a rule about portfolio weight should not change its
      // mind because someone moved a thin pool for one block.
      feeds[`position:${asset.symbol}`] = held;
      feeds[`value:${asset.symbol}`] = value.toFixed();
    }
    feeds.cash = cash.toFixed();
    feeds.equity = equity.toFixed();
    return { at: Date.now(), feeds, portfolio: { equity: equity.toFixed(), positions } };
  }
  async authorize(context: Context): Promise<EmbeddedWallet> {
    const { draft, instance, owner } = context;
    if (
      !this.signer ||
      !this.config.execute ||
      instance.status !== "armed" ||
      instance.mode !== "auto" ||
      draft.mode !== "auto"
    )
      throw new Error("Execution not authorized");
    if (
      !instance.eligibleCountry ||
      !this.config.eligibleCountries.includes(instance.eligibleCountry) ||
      !instance.eligibilityExpiresAt ||
      instance.eligibilityExpiresAt.getTime() <= Date.now()
    )
      throw new Error("Eligibility renewal required");
    const now = Math.floor(Date.now() / 1000);
    if (
      Date.parse(draft.envelope.caps.expires_at) <= Date.now() ||
      !(this.config.ignoreSession || executionSession(new Date()))
    )
      throw new Error("Execution window closed");
    // The wallet is read from Privy on every authorisation, never cached: a user who removes
    // the delegation has withdrawn consent, and the next order must see that.
    const wallet = await this.signer.wallet(owner.privyDid, draft.account);
    if (!wallet) throw new Error("Strategy wallet is not an embedded wallet");
    if (!wallet.delegated) throw new Error("Automatic buying is not enabled for this wallet");
    for (const asset of draft.envelope.assets) {
      const [multiplier, paused] = await this.client.readContract({
        address: ORACLE_REGISTRY,
        abi,
        functionName: "getOracleParams",
        args: [asset.token],
      });
      const transferPaused = await this.client.readContract({
        address: asset.token,
        abi,
        functionName: "isPaused",
        args: [0],
      });
      const round = await this.client.readContract({
        address: asset.feed,
        abi,
        functionName: "latestRoundData",
      });
      if (
        paused ||
        transferPaused ||
        multiplier <= 0n ||
        round[1] <= 0n ||
        round[4] < round[0] ||
        round[3] > BigInt(now) ||
        BigInt(now) - round[3] > 300n
      )
        throw new Error("Oracle or transfer unavailable");
      const scope = await this.client.readContract({
        address: asset.token,
        abi,
        functionName: "TRANSFER_RECEIVER_POLICY",
      });
      const policy = await this.client.readContract({
        address: asset.token,
        abi,
        functionName: "policyId",
        args: [scope],
      });
      if (
        !(await this.client.readContract({
          address: POLICY_REGISTRY,
          abi,
          functionName: "isAuthorized",
          args: [policy, draft.account as Hex],
        }))
      )
        throw new Error("Recipient not authorized");
    }
    return wallet;
  }
  private async guard(order: ExecutionRow, context: Context) {
    const { draft, instance } = context;
    await verifyCommitment(draft, instance, this.config.origin, this.reader);
    const wallet = await this.authorize(context);
    const intent = order.intent;
    const asset = intent ? draft.envelope.assets[intent.asset] : undefined;
    if (
      !asset ||
      intent?.side !== "buy" ||
      order.tokenIn.toLowerCase() !== USDC.toLowerCase() ||
      order.tokenOut.toLowerCase() !== asset.token.toLowerCase() ||
      order.amountIn !== units(intent.amount, 6).toString()
    )
      throw new Error("Unsupported order");
    if (Date.now() - order.createdAt.getTime() > ORDER_DEADLINE_MS)
      throw new Error("Order intent expired before signing");
    const [machineId, stateId, transitionIndex] = intent.fireKey.split("/");
    const rule = draft.plan.machines
      .find((m) => m.id === machineId)
      ?.states.find((s) => s.id === stateId)?.transitions[Number(transitionIndex)];
    const snapshot = await this.snapshot(draft);
    if (!rule || evaluate(draft.plan, snapshot.feeds).get(rule.when) !== true)
      throw new Error("Order condition no longer holds");
    return { asset, wallet };
  }
  async prepare(leg: Leg, order: ExecutionRow, context: Context): Promise<Prepared> {
    if (!this.signer || !this.config.execute) throw new Error("Live execution disabled");
    if ((await this.client.getChainId()) !== 8453) throw new RecoveryRequired("Wrong network");
    const amount = BigInt(order.amountIn);
    const { asset, wallet } = await this.guard(order, context);
    const owner = wallet.address;
    // The user's wallet pays. An order it cannot cover is cancelled at admission checks, not
    // left to revert on chain and cost gas.
    const balance = await this.client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    });
    if (balance < amount) throw new Error("Not enough USDC in the strategy wallet");
    let to: Hex = USDC;
    let data: Hex;
    let evidence: Prepared["evidence"] = null;
    if (leg === "swap") {
      const quote = await this.reader.quote(
        asset,
        "buy",
        order.intent?.amount ?? "0",
        context.draft.envelope.caps.slippage_bps,
      );
      to = ROUTER;
      data = encodeFunctionData({
        abi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: USDC,
            tokenOut: asset.token,
            tickSpacing: quote.tick_spacing,
            recipient: owner,
            deadline: BigInt(
              Math.floor(
                Math.min(
                  Date.parse(quote.expires_at),
                  Date.parse(context.draft.envelope.caps.expires_at),
                ) / 1000,
              ),
            ),
            amountIn: amount,
            amountOutMinimum: BigInt(quote.min_out),
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      evidence = { token: asset.token, recipient: owner, amount: quote.min_out };
    } else {
      data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [ROUTER, amount],
      });
    }
    // An unknown pending nonce on the user's wallet cannot be attributed to this order. The
    // wallet is theirs: they may have sent something from it themselves, and this waits.
    const [latest, pending] = await Promise.all([
      this.client.getTransactionCount({ address: owner, blockTag: "latest" }),
      this.client.getTransactionCount({ address: owner, blockTag: "pending" }),
    ]);
    if (latest !== pending) throw new RecoveryRequired("Wallet has an unknown pending transaction");
    const account = this.signer.account(wallet);
    await this.client.call({ account: owner, to, data });
    const signing = createWalletClient({ chain: base, transport: this.transport, account });
    const request = await signing.prepareTransactionRequest({
      account,
      to,
      data,
      value: 0n,
      nonce: pending,
    });
    const rawTransaction = await signing.signTransaction(request);
    return {
      rawTransaction,
      hash: keccak256(rawTransaction),
      nonce: pending,
      signer: owner.toLowerCase(),
      evidence,
    };
  }
  async observe(transaction: TransactionRow): Promise<Observation> {
    if ((await this.client.getChainId()) !== 8453) throw new RecoveryRequired("Wrong network");
    let receipt: Awaited<ReturnType<typeof this.client.getTransactionReceipt>>;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: transaction.hash as Hex });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      const nonce = await this.client.getTransactionCount({
        address: transaction.signer as Hex,
        blockTag: "latest",
      });
      return nonce > transaction.nonce ? "ambiguous" : "pending";
    }
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) return "ambiguous";
    if (
      (await this.client.getBlockNumber({ cacheTime: 0 })) - receipt.blockNumber + 1n <
      BigInt(this.config.confirmations)
    )
      return "pending";
    if (receipt.status === "reverted") return "reverted";
    const proof = transaction.evidence;
    if (proof) {
      let received = 0n;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== proof.token.toLowerCase()) continue;
        try {
          const event = decodeEventLog({
            abi: erc20Abi,
            eventName: "Transfer",
            data: log.data,
            topics: log.topics,
          });
          if (
            event.args.to.toLowerCase() === proof.recipient.toLowerCase() &&
            (!proof.from || event.args.from.toLowerCase() === proof.from.toLowerCase())
          )
            received += event.args.value;
        } catch {
          /* Other token events are not evidence. */
        }
      }
      if (received < BigInt(proof.amount)) return "ambiguous";
      if (transaction.leg !== "swap" && received !== BigInt(proof.amount)) return "ambiguous";
    }
    return "confirmed";
  }
  async broadcast(transaction: TransactionRow) {
    if (
      !this.config.execute ||
      !this.signer ||
      keccak256(transaction.rawTransaction as Hex) !== transaction.hash
    )
      throw new RecoveryRequired("Invalid journal hash");
    if ((await this.client.getChainId()) !== 8453) throw new RecoveryRequired("Wrong network");
    await this.client.sendRawTransaction({
      serializedTransaction: transaction.rawTransaction as Hex,
    });
  }
}
