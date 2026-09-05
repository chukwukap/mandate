import type { WorkerConfig } from "@mandate/config";
import type { Hex } from "@mandate/contracts";
import type { DraftRow, ExecutionRow, TransactionRow } from "@mandate/database";
import { BaseReader, permissionHash, SPEND_MANAGER, USDC } from "@mandate/evm";
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
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });
export const ROUTER = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" as const;
const ORACLE_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as const;
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002" as const;
const abi = parseAbi([
  "struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }",
  "function spend(SpendPermission permission,uint160 value)",
  "function getCurrentPeriod(SpendPermission permission) view returns ((uint48 start,uint48 end,uint160 spend))",
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
export class WorkerChain implements Observations, Executor {
  readonly reader: BaseReader;
  readonly client;
  readonly account;
  readonly wallet;
  constructor(
    private readonly config: WorkerConfig,
    injectedTransport?: Transport,
  ) {
    const transport =
      injectedTransport ??
      http(config.rpcUrl, {
        timeout: 5000,
        retryCount: 1,
        batch: { wait: 30, batchSize: 5 },
      });
    this.client = createPublicClient({ chain: base, transport });
    this.reader = new BaseReader(this.client);
    this.account =
      config.execute && config.privateKey
        ? privateKeyToAccount(config.privateKey as Hex)
        : undefined;
    if (this.account && this.account.address.toLowerCase() !== config.spender?.toLowerCase())
      throw new Error("Worker key does not match SPENDER_ADDRESS");
    this.wallet = this.account
      ? createWalletClient({ chain: base, transport, account: this.account })
      : undefined;
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
    let equity = new Money(
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
    const positions: Record<string, string> = {};
    for (const asset of draft.envelope.assets) {
      const balance = await this.client.readContract({
        address: asset.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [draft.account as Hex],
      });
      const value = whole(balance, asset.decimals);
      positions[asset.token.toLowerCase()] = value;
      equity = equity.plus(new Money(value).mul(feeds[`oracle:${asset.symbol}`] ?? "NaN"));
    }
    return { at: Date.now(), feeds, portfolio: { equity: equity.toFixed(), positions } };
  }
  async authorize(context: Context) {
    const { draft, instance, permission } = context;
    if (
      !this.account ||
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
    if (Date.parse(draft.envelope.caps.expires_at) <= Date.now() || !executionSession(new Date()))
      throw new Error("Execution window closed");
    if (permission?.status !== "active" || !permission.signature)
      throw new Error("Missing permission");
    const p = permission.payload;
    if (
      permissionHash(p) !== permission.hash ||
      p.account.toLowerCase() !== draft.account.toLowerCase() ||
      p.spender.toLowerCase() !== this.account.address.toLowerCase() ||
      p.token.toLowerCase() !== USDC.toLowerCase() ||
      p.period !== draft.envelope.caps.period_secs ||
      p.allowance !== units(draft.envelope.caps.per_period, 6).toString() ||
      p.end * 1000 > Date.parse(draft.envelope.caps.expires_at) ||
      p.start > now ||
      p.end <= now ||
      !(await this.reader.verifyPermission(p, permission.signature as Hex))
    )
      throw new Error("Permission mismatch");
    const state = await this.reader.permissionStatus(p);
    if (!state.approved || state.revoked) throw new Error("Permission inactive");
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
    return p;
  }
  private async guard(order: ExecutionRow, context: Context, funding: boolean) {
    const { draft, instance } = context;
    await verifyCommitment(draft, instance, this.config.origin, this.reader);
    const p = await this.authorize(context);
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
    if (funding && Date.now() - order.createdAt.getTime() > 60000)
      throw new Error("Order intent expired before funding");
    if (funding) {
      const period = await this.client.readContract({
        address: SPEND_MANAGER,
        abi,
        functionName: "getCurrentPeriod",
        args: [{ ...p, allowance: BigInt(p.allowance), salt: BigInt(p.salt) }],
      });
      if (period.spend + BigInt(order.amountIn) > BigInt(p.allowance))
        throw new Error("Permission allowance exhausted");
    }
    const [machineId, stateId, transitionIndex] = intent.fireKey.split("/");
    const rule = draft.plan.machines
      .find((m) => m.id === machineId)
      ?.states.find((s) => s.id === stateId)?.transitions[Number(transitionIndex)];
    const snapshot = await this.snapshot(draft);
    if (!rule || evaluate(draft.plan, snapshot.feeds).get(rule.when) !== true)
      throw new Error("Order condition no longer holds");
    return { asset, permission: p };
  }
  async prepare(leg: Leg, order: ExecutionRow, context: Context): Promise<Prepared> {
    if (!this.account || !this.wallet || !this.config.execute)
      throw new Error("Live execution disabled");
    if ((await this.client.getChainId()) !== 8453) throw new RecoveryRequired("Wrong network");
    const amount = BigInt(order.amountIn);
    const recipient = context.draft.account as Hex;
    let to: Hex = USDC;
    let data: Hex;
    let evidence: Prepared["evidence"] = null;
    if (leg === "fund") {
      const { asset, permission } = await this.guard(order, context, true);
      // Establish route before pulling funds; refresh it again for the swap.
      await this.reader.quote(
        asset,
        "buy",
        order.intent?.amount ?? "0",
        context.draft.envelope.caps.slippage_bps,
      );
      to = SPEND_MANAGER;
      data = encodeFunctionData({
        abi,
        functionName: "spend",
        args: [
          { ...permission, allowance: BigInt(permission.allowance), salt: BigInt(permission.salt) },
          amount,
        ],
      });
      evidence = {
        token: USDC,
        recipient: this.account.address,
        amount: amount.toString(),
        from: recipient,
      };
    } else {
      const balance = await this.client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.account.address],
      });
      if (balance < amount) throw new RecoveryRequired("Funded input no longer available");
      if (leg === "swap") {
        const { asset } = await this.guard(order, context, false);
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
              recipient,
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
        evidence = { token: asset.token, recipient, amount: quote.min_out };
      } else if (leg === "refund") {
        const allowance = await this.client.readContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "allowance",
          args: [this.account.address, ROUTER],
        });
        if (allowance !== 0n) throw new RecoveryRequired("Router allowance remains");
        data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, amount],
        });
        evidence = {
          token: USDC,
          recipient,
          amount: amount.toString(),
          from: this.account.address,
        };
      } else {
        if (leg === "approve") await this.guard(order, context, false);
        data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [ROUTER, leg === "reset" ? 0n : amount],
        });
      }
    }
    // A private, dedicated signer is required. An unknown external pending nonce
    // cannot be attributed to this order and blocks signing.
    const [latest, pending] = await Promise.all([
      this.client.getTransactionCount({ address: this.account.address, blockTag: "latest" }),
      this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" }),
    ]);
    if (latest !== pending) throw new RecoveryRequired("Signer has an unknown pending transaction");
    await this.client.call({ account: this.account, to, data });
    const request = await this.wallet.prepareTransactionRequest({
      account: this.account,
      to,
      data,
      value: 0n,
      nonce: pending,
    });
    const rawTransaction = await this.wallet.signTransaction(request);
    return {
      rawTransaction,
      hash: keccak256(rawTransaction),
      nonce: pending,
      signer: this.account.address.toLowerCase(),
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
      !this.account ||
      this.account.address.toLowerCase() !== transaction.signer ||
      keccak256(transaction.rawTransaction as Hex) !== transaction.hash
    )
      throw new RecoveryRequired("Invalid journal signer or hash");
    if ((await this.client.getChainId()) !== 8453) throw new RecoveryRequired("Wrong network");
    await this.client.sendRawTransaction({
      serializedTransaction: transaction.rawTransaction as Hex,
    });
  }
}
