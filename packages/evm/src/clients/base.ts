import {
  type Asset,
  type ChainReader,
  type Hex,
  type MarketFeed,
  type PermissionPayload,
  Problem,
  type Quote,
} from "@mandate/contracts";
import { Decimal } from "decimal.js";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  type PublicClient,
  parseAbi,
  parseUnits,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import { ASSETS, QUOTER, TICK_SPACINGS } from "../addresses/index.js";
import {
  CHAIN_ID,
  permissionAbi,
  permissionMessage,
  permissionTypedData,
  SPEND_MANAGER,
  USDC,
} from "../permissions/index.js";
import { pacedFetch } from "./paced-fetch.js";

const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });
const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);
const accountAbi = parseAbi(["function isOwnerAddress(address owner) view returns (bool)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
/** USDC precision. Published prices are quoted in it, so they are rounded to it. */
const USDC_DECIMALS = 6;

/**
 * How old a Chainlink answer may be before the reference is called stale.
 *
 * These are Coinbase total-return equity feeds, and Chainlink documents that they have NO
 * heartbeat during off-hours and simply hold the last close while the underlying market is shut.
 * Measured on a weekday evening, the AAPL feed's answer was already 15.07h old with nothing wrong.
 *
 * So this bound cannot be read as "the feed is broken". It is the point past which the reference
 * is too old to price against, and a normal weekend — Friday close to Monday open is roughly 64h —
 * exceeds any value tuned to a weeknight. 26h therefore marks every asset stale for the whole
 * weekend, which is a deliberate refusal to trade against a two-day-old reference on a token that
 * itself trades 24/7, NOT a malfunction to be widened away.
 *
 * Widening it is a product decision with real risk attached: the pool price moves over a weekend
 * while the reference does not, so a wider bound silently authorises trading against a number that
 * no longer describes the asset. Left narrow on purpose, and named so the choice is visible.
 */
const MAX_REFERENCE_AGE = 26 * 3600;
export class BaseReader implements ChainReader {
  private networkCheckedAt = 0;
  private cachedMarket: { at: number; feeds: MarketFeed[] } | undefined;
  private pendingMarket: Promise<MarketFeed[]> | undefined;
  constructor(
    private readonly client: PublicClient<Transport, typeof base>,
    private readonly assets: readonly Asset[] = ASSETS,
  ) {}
  static fromUrl(url: string) {
    return new BaseReader(
      createPublicClient({
        chain: base,
        transport: http(url, {
          timeout: 5000,
          retryCount: 1,
          retryDelay: 1000,
          batch: { wait: 30, batchSize: 20 },
          fetchFn: pacedFetch(),
        }),
      }),
    );
  }
  private async network() {
    if (Date.now() - this.networkCheckedAt < 30_000) return;
    if ((await this.client.getChainId()) !== CHAIN_ID)
      throw Problem.unavailable("RPC endpoint is not Base mainnet.");
    this.networkCheckedAt = Date.now();
  }
  async ready() {
    try {
      this.networkCheckedAt = 0;
      await this.network();
      await this.client.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }
  async verifyMessage(address: Hex, message: string, signature: Hex) {
    await this.network();
    return this.client.verifyMessage({ address, message, signature });
  }
  async verifyPermission(payload: PermissionPayload, signature: Hex) {
    await this.network();
    return this.client.verifyTypedData({
      address: payload.account,
      ...permissionTypedData(payload),
      signature,
    });
  }
  async walletKind(address: Hex) {
    await this.network();
    const code = await this.client.getCode({ address });
    if (!code || code === "0x") return "eoa" as const;
    try {
      const owner = await this.client.readContract({
        address,
        abi: accountAbi,
        functionName: "isOwnerAddress",
        args: [SPEND_MANAGER],
      });
      return owner ? ("base_account" as const) : ("contract" as const);
    } catch {
      return "contract" as const;
    }
  }
  async permissionStatus(payload: PermissionPayload) {
    await this.network();
    const args = [permissionMessage(payload)] as const;
    const [approved, revoked] = await Promise.all([
      this.client.readContract({
        address: SPEND_MANAGER,
        abi: permissionAbi,
        functionName: "isApproved",
        args,
      }),
      this.client.readContract({
        address: SPEND_MANAGER,
        abi: permissionAbi,
        functionName: "isRevoked",
        args,
      }),
    ]);
    return { approved, revoked };
  }
  private async reference(asset: Asset): Promise<MarketFeed> {
    const [round, decimals, symbol, tokenDecimals, supply] = await Promise.all([
      this.client.readContract({
        address: asset.feed,
        abi: feedAbi,
        functionName: "latestRoundData",
      }),
      this.client.readContract({ address: asset.feed, abi: feedAbi, functionName: "decimals" }),
      this.client.readContract({ address: asset.token, abi: erc20Abi, functionName: "symbol" }),
      this.client.readContract({ address: asset.token, abi: erc20Abi, functionName: "decimals" }),
      this.client.readContract({
        address: asset.token,
        abi: erc20Abi,
        functionName: "totalSupply",
      }),
    ]);
    if (
      symbol !== asset.symbol ||
      tokenDecimals !== asset.decimals ||
      supply <= 0n ||
      decimals > 36
    )
      throw new Error("Asset metadata unavailable or mismatched");
    const [roundId, answer, , updatedAt, answeredInRound] = round;
    const now = Math.floor(Date.now() / 1000);
    if (
      answer <= 0n ||
      updatedAt <= 0n ||
      updatedAt > BigInt(now + 60) ||
      answeredInRound < roundId
    )
      throw new Error("Invalid reference round");
    return {
      uri: `oracle:${asset.symbol}`,
      value: formatUnits(answer, decimals),
      updated_at: Number(updatedAt),
      stale: now - Number(updatedAt) > MAX_REFERENCE_AGE,
    };
  }
  private async route(
    asset: Asset,
    side: "buy" | "sell",
    amount: string,
    slippageBps: number,
    reference: string,
  ): Promise<Quote> {
    const decimals = side === "buy" ? 6 : asset.decimals;
    if (
      !/^\d{1,30}(\.\d{1,18})?$/.test(amount) ||
      (amount.split(".")[1]?.length ?? 0) > decimals ||
      !Number.isInteger(slippageBps) ||
      slippageBps < 1 ||
      slippageBps > 500
    )
      throw new Problem(
        400,
        "invalid-amount",
        "Invalid quote amount",
        "Use a positive amount within the input token's precision and valid slippage.",
      );
    const raw = parseUnits(amount, decimals);
    if (raw === 0n)
      throw new Problem(400, "zero-amount", "Amount is zero", "Enter a positive amount.");
    const tokenIn = side === "buy" ? USDC : asset.token;
    const tokenOut = side === "buy" ? asset.token : USDC;
    const quotes = await Promise.allSettled(
      TICK_SPACINGS.map(async (tickSpacing) => {
        const { result } = await this.client.simulateContract({
          address: QUOTER,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn: raw, tickSpacing, sqrtPriceLimitX96: 0n }],
        });
        const out = result[0];
        if (out <= 0n) throw new Error("Empty quote");
        const output = new Money(formatUnits(out, side === "buy" ? asset.decimals : 6));
        const implied = side === "buy" ? new Money(amount).div(output) : output.div(amount);
        if (implied.div(reference).minus(1).abs().gt("0.05"))
          throw new Error("Quote outside reference band");
        return { out, tickSpacing };
      }),
    );
    const valid = quotes.flatMap((q) => (q.status === "fulfilled" ? [q.value] : []));
    valid.sort((a, b) => (a.out > b.out ? -1 : a.out < b.out ? 1 : 0));
    const best = valid[0];
    if (!best)
      throw Problem.unavailable(
        "No usable Aerodrome quote within 5% of the reference price at this size.",
      );
    return {
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: raw.toString(),
      amount_out: best.out.toString(),
      min_out: ((best.out * BigInt(10000 - slippageBps)) / 10000n).toString(),
      tick_spacing: best.tickSpacing,
      expires_at: new Date(Date.now() + 20_000).toISOString(),
      reference,
    };
  }
  async quote(asset: Asset, side: "buy" | "sell", amount: string, slippageBps: number) {
    await this.network();
    if (
      !this.assets.some(
        (a) =>
          a.token.toLowerCase() === asset.token.toLowerCase() &&
          a.feed.toLowerCase() === asset.feed.toLowerCase() &&
          a.symbol === asset.symbol &&
          a.decimals === asset.decimals,
      )
    )
      throw new Problem(400, "unknown-asset", "Unknown asset", "Choose a catalogue asset.");
    let reference: MarketFeed;
    try {
      reference = await this.reference(asset);
    } catch {
      throw Problem.unavailable("A verified reference price is unavailable.");
    }
    if (reference.stale || !reference.value)
      throw Problem.unavailable("Reference price is too old for a quote.");
    return this.route(asset, side, amount, slippageBps, reference.value);
  }
  async market(): Promise<MarketFeed[]> {
    if (this.cachedMarket && Date.now() - this.cachedMarket.at < 15_000)
      return structuredClone(this.cachedMarket.feeds);
    if (this.pendingMarket) return structuredClone(await this.pendingMarket);
    this.pendingMarket = this.loadMarket();
    try {
      const feeds = await this.pendingMarket;
      this.cachedMarket = { at: Date.now(), feeds };
      return structuredClone(feeds);
    } finally {
      this.pendingMarket = undefined;
    }
  }
  private async loadMarket() {
    try {
      await this.network();
    } catch {
      return this.assets.flatMap((asset) => this.unavailable(asset));
    }
    // Bound RPC bursts on the public endpoint — but bound them, do not serialise them.
    //
    // Measured against a public Base endpoint, a single eth_call round trip is ~0.85s, and each
    // asset costs two of them (the reference read, then the routed quote). Walking the catalogue
    // one asset at a time therefore grows linearly and crossed the 10s snapshot deadline at four
    // assets, which surfaced as every asset after the first reporting "chain-unavailable" — a
    // caller cannot tell that from the chain actually being down.
    //
    // A small window keeps the burst polite while making the wall clock depend on the catalogue's
    // size only in steps. Four is chosen to match the free-tier concurrency these endpoints
    // tolerate without shedding; raising it trades reliability for latency, so it is a constant
    // with a reason rather than a knob.
    const WINDOW = 4;
    const values: MarketFeed[][] = [];
    for (let i = 0; i < this.assets.length; i += WINDOW) {
      const window = this.assets.slice(i, i + WINDOW);
      // assetMarket never rejects — it degrades each asset to "unavailable" — so allSettled would
      // add nothing here beyond hiding a future refactor that starts throwing.
      values.push(...(await Promise.all(window.map((asset) => this.assetMarket(asset)))));
    }
    return values.flat();
  }
  private async assetMarket(asset: Asset): Promise<MarketFeed[]> {
    try {
      const reference = await this.reference(asset);
      if (reference.stale || !reference.value)
        return [reference, this.unavailableFeed(asset, "dex")];
      try {
        const quote = await this.route(asset, "buy", "10", 50, reference.value);
        // Quantised to the quote token's precision. `Money` carries 78 significant digits so
        // intermediate arithmetic never rounds, but a *published* price must not: an unrounded
        // division emits values like 321.327468035950117123, which is not a USDC price, breaks
        // any consumer parsing it as a decimal, and implies precision the pool cannot settle at.
        // ROUND_DOWN is inherited from Money, so this never rounds a price up into a band it did
        // not actually reach.
        const price = new Money(10)
          .div(formatUnits(BigInt(quote.amount_out), asset.decimals))
          .toDecimalPlaces(USDC_DECIMALS, Decimal.ROUND_DOWN)
          .toFixed();
        return [
          reference,
          {
            uri: `dex:${asset.symbol}`,
            value: price,
            updated_at: Math.floor(Date.now() / 1000),
            stale: false,
          },
        ];
      } catch {
        return [reference, this.unavailableFeed(asset, "dex")];
      }
    } catch {
      return this.unavailable(asset);
    }
  }
  private unavailableFeed(asset: Asset, kind: "oracle" | "dex"): MarketFeed {
    return { uri: `${kind}:${asset.symbol}`, value: null, updated_at: 0, stale: true };
  }
  private unavailable(asset: Asset): MarketFeed[] {
    return ["oracle", "dex"].map((kind) => ({
      uri: `${kind}:${asset.symbol}`,
      value: null,
      updated_at: 0,
      stale: true,
    }));
  }
}
