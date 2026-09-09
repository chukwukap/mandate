import type { Asset, Call, Hex, Quote } from "@mandate/contracts";
import { Problem } from "@mandate/contracts";
import {
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  encodeFunctionData,
  type PublicClient,
  type Transport,
  zeroAddress,
} from "viem";
import { clFactoryAbi, clPoolAbi, quoterV2Abi, swapRouterAbi } from "../abis/index.js";
import { CHAIN_ID, QUOTER, TICK_SPACINGS, USDC } from "../addresses/index.js";
import {
  minOut,
  type RouteCandidate,
  type RouteRejection,
  SANITY_BAND_BPS,
  type Side,
  selectRoute,
} from "./sanity.js";

/** Aerodrome Slipstream CLFactory on Base. */
export const SLIPSTREAM_FACTORY = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef" as const;
/** Aerodrome Slipstream SwapRouter on Base. Same address the worker broadcasts to. */
export const SLIPSTREAM_SWAP_ROUTER = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" as const;
export { QUOTER as SLIPSTREAM_QUOTER } from "../addresses/index.js";

/**
 * 20s, matching the published API contract.
 *
 * It is tight against the cost of producing the quote: six tick-spacing probes through a
 * transport that paces requests 1200ms apart is ~7s of wall clock before the reference read,
 * so a quote can reach its caller already a third of the way through its life. The number is
 * exported rather than inlined precisely so the worker's deadline math uses the real value
 * instead of assuming a fresh 20s.
 */
export const QUOTE_TTL_MS = 20_000;

/**
 * Chain is a type parameter, not a fixed `Chain`: viem threads it through action parameter
 * types, so `PublicClient<Transport, Chain>` is invariant and would reject the concrete
 * Base client that `BaseReader` and the worker actually hold.
 */
export type RouterClient<chain extends Chain | undefined = Chain | undefined> = PublicClient<
  Transport,
  chain
>;

export type SlipstreamOptions = {
  quoter?: Hex;
  factory?: Hex;
  swapRouter?: Hex;
  /** Probe set. Bounded on purpose: every extra spacing is another paced RPC round trip. */
  tickSpacings?: readonly number[];
  bandBps?: number;
  ttlMs?: number;
  now?: () => number;
};

export type ProbeResult = {
  candidates: RouteCandidate[];
  rejected: RouteRejection[];
};

export type RouteQuote = {
  side: Side;
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  tickSpacing: number;
  /** USDC per whole share implied by the selected fill. */
  impliedPrice: string;
  referencePrice: string;
  deviationBps: number;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
  /** ms since epoch. */
  expiresAt: number;
  /** Every spacing that did not make it, and why. Diagnostics, never secrets. */
  rejected: RouteRejection[];
};

export type PoolStatus = "missing" | "empty" | "liquid" | "unreadable";

export type PoolInfo = {
  tickSpacing: number;
  pool: Hex | null;
  liquidity: bigint;
  status: PoolStatus;
};

/**
 * A reverted probe is a route that does not exist; a transport failure is not.
 *
 * Both arrive at `Promise.allSettled` looking identical, and viem wraps everything in
 * `ContractFunctionExecutionError`, so the class of the outer error decides nothing. The
 * discriminator is whether a revert appears anywhere in the cause chain. Without this,
 * a rate-limited RPC — `pacedFetch` throws a plain Error once its queue is full — would be
 * silently reported as "this pair has no liquidity", and the system would look calmly
 * broken instead of loudly degraded.
 */
function classifyProbeFailure(error: unknown): "no-route" | "upstream" {
  if (error instanceof Problem) return "upstream";
  if (!(error instanceof BaseError)) return "upstream";
  const reverted = error.walk(
    (cause) =>
      cause instanceof ContractFunctionRevertedError ||
      cause instanceof ExecutionRevertedError ||
      // Empty return data: no contract at the pool address, or a pool that answered
      // nothing. Either way there is no route here.
      cause instanceof ContractFunctionZeroDataError,
  );
  return reverted ? "no-route" : "upstream";
}

/**
 * Aerodrome Slipstream routing.
 *
 * Every quote probes all configured tick spacings, checks each result against the Chainlink
 * reference independently, and only then takes the largest admitted output. See
 * `selectRoute` for why that ordering is not optional.
 */
export class SlipstreamRouter<chain extends Chain | undefined = Chain | undefined> {
  private readonly quoter: Hex;
  private readonly factory: Hex;
  private readonly swapRouter: Hex;
  private readonly tickSpacings: readonly number[];
  private readonly bandBps: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly client: RouterClient<chain>,
    options: SlipstreamOptions = {},
  ) {
    this.quoter = options.quoter ?? QUOTER;
    this.factory = options.factory ?? SLIPSTREAM_FACTORY;
    this.swapRouter = options.swapRouter ?? SLIPSTREAM_SWAP_ROUTER;
    this.tickSpacings = options.tickSpacings ?? TICK_SPACINGS;
    this.bandBps = options.bandBps ?? SANITY_BAND_BPS;
    this.ttlMs = options.ttlMs ?? QUOTE_TTL_MS;
    this.now = options.now ?? Date.now;
    if (this.tickSpacings.length === 0)
      throw new Error("SlipstreamRouter requires at least one tick spacing to probe");
  }

  /**
   * Quote the same swap at every tick spacing.
   *
   * Runs under `allSettled` so one dead pool cannot cancel the probes that would have
   * routed the order. Nothing is priced or compared here — this returns raw outputs, and
   * they are not safe to act on until `selectRoute` has admitted them.
   */
  async probe(params: { tokenIn: Hex; tokenOut: Hex; amountIn: bigint }): Promise<ProbeResult> {
    if (params.amountIn <= 0n)
      throw new Problem(
        400,
        "zero-amount",
        "Amount is zero",
        "A route needs a positive input amount.",
      );
    if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase())
      throw new Problem(
        400,
        "invalid-amount",
        "Invalid pair",
        "A route needs two different tokens.",
      );
    const settled = await Promise.allSettled(
      this.tickSpacings.map(async (tickSpacing) => {
        const { result } = await this.client.simulateContract({
          address: this.quoter,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: params.tokenIn,
              tokenOut: params.tokenOut,
              amountIn: params.amountIn,
              tickSpacing,
              // 0 lets the quoter walk the whole curve. That is exactly how a near-empty
              // pool manufactures an absurd price, so the limit is deliberately not used
              // as the guard: the reference band rejects such a quote, and `minOut` bounds
              // what the swap may actually accept.
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const [amountOut, , initializedTicksCrossed, gasEstimate] = result;
        return {
          tickSpacing,
          amountOut,
          initializedTicksCrossed: Number(initializedTicksCrossed),
          gasEstimate,
        } satisfies RouteCandidate;
      }),
    );
    const candidates: RouteCandidate[] = [];
    const rejected: RouteRejection[] = [];
    settled.forEach((outcome, index) => {
      const tickSpacing = this.tickSpacings[index];
      if (tickSpacing === undefined) return;
      if (outcome.status === "fulfilled") candidates.push(outcome.value);
      else rejected.push({ tickSpacing, reason: classifyProbeFailure(outcome.reason) });
    });
    return { candidates, rejected };
  }

  /**
   * Probe, admit against the reference, and return the best usable route.
   *
   * `reference` is required and has no default: a route may not be selected without an
   * independent price to check it against.
   */
  async quoteExactInput(params: {
    asset: Asset;
    side: Side;
    amountIn: bigint;
    slippageBps: number;
    reference: string;
    quoteToken?: Hex;
  }): Promise<RouteQuote> {
    const quoteToken = params.quoteToken ?? USDC;
    const tokenIn = params.side === "buy" ? quoteToken : params.asset.token;
    const tokenOut = params.side === "buy" ? params.asset.token : quoteToken;
    const { candidates, rejected } = await this.probe({
      tokenIn,
      tokenOut,
      amountIn: params.amountIn,
    });
    const selection = selectRoute({
      side: params.side,
      amountIn: params.amountIn,
      assetDecimals: params.asset.decimals,
      reference: params.reference,
      candidates,
      rejected,
      bandBps: this.bandBps,
    });
    const best = selection.best;
    return {
      side: params.side,
      tokenIn,
      tokenOut,
      amountIn: params.amountIn,
      amountOut: best.amountOut,
      minOut: minOut(best.amountOut, params.slippageBps),
      tickSpacing: best.tickSpacing,
      impliedPrice: best.impliedPrice,
      referencePrice: params.reference,
      deviationBps: best.deviationBps,
      initializedTicksCrossed: best.initializedTicksCrossed,
      gasEstimate: best.gasEstimate,
      expiresAt: this.now() + this.ttlMs,
      rejected: selection.rejected,
    };
  }

  /**
   * Diagnostics: which pools exist for a pair, and which of them actually hold anything.
   *
   * Pool existence is not liquidity. Several B20 pairs have a non-zero factory address, a
   * `liquidity()` of 0, and a quote that reverts. `liquidity == 0` is reported as `empty`,
   * never raised — and a read that fails is reported as `unreadable` rather than aborting
   * the survey, because a partial survey is still useful.
   */
  async pools(tokenA: Hex, tokenB: Hex): Promise<PoolInfo[]> {
    return Promise.all(
      this.tickSpacings.map(async (tickSpacing): Promise<PoolInfo> => {
        try {
          const pool = await this.client.readContract({
            address: this.factory,
            abi: clFactoryAbi,
            functionName: "getPool",
            args: [tokenA, tokenB, tickSpacing],
          });
          // Short-circuit: reading liquidity() on address(0) returns empty data, which
          // viem raises as a decode error rather than the "no pool" it actually means.
          if (pool === zeroAddress)
            return { tickSpacing, pool: null, liquidity: 0n, status: "missing" };
          const liquidity = await this.client.readContract({
            address: pool,
            abi: clPoolAbi,
            functionName: "liquidity",
          });
          return {
            tickSpacing,
            pool,
            liquidity,
            status: liquidity > 0n ? "liquid" : "empty",
          };
        } catch {
          return { tickSpacing, pool: null, liquidity: 0n, status: "unreadable" };
        }
      }),
    );
  }

  /**
   * Encode the SwapRouter call for a selected route.
   *
   * `amountOutMinimum` must be positive. A zero floor is a swap that will accept any
   * output at all, which on Base mainnet is an open invitation to a sandwich; there is no
   * legitimate reason for this system to sign one, so it is refused rather than defaulted.
   */
  exactInputSingleCall(params: {
    tokenIn: Hex;
    tokenOut: Hex;
    tickSpacing: number;
    recipient: Hex;
    /** Unix seconds. */
    deadline: number;
    amountIn: bigint;
    amountOutMinimum: bigint;
  }): Call {
    if (params.amountIn <= 0n)
      throw new Problem(400, "zero-amount", "Amount is zero", "A swap needs a positive input.");
    if (params.amountOutMinimum <= 0n)
      throw new Problem(
        400,
        "invalid-amount",
        "Missing slippage floor",
        "A swap must carry a positive minimum output.",
      );
    if (!Number.isInteger(params.tickSpacing) || params.tickSpacing <= 0)
      throw new Problem(
        400,
        "invalid-amount",
        "Invalid tick spacing",
        "Aerodrome Slipstream pools are keyed by a positive tick spacing.",
      );
    if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase())
      throw new Problem(
        400,
        "invalid-amount",
        "Invalid pair",
        "A swap needs two different tokens.",
      );
    if (!Number.isInteger(params.deadline) || params.deadline <= Math.floor(this.now() / 1000))
      throw new Problem(
        400,
        "invalid-amount",
        "Deadline expired",
        "A swap deadline must be a whole second in the future.",
      );
    return {
      to: this.swapRouter,
      chain_id: CHAIN_ID,
      value: "0",
      data: encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            tickSpacing: params.tickSpacing,
            recipient: params.recipient,
            deadline: BigInt(params.deadline),
            amountIn: params.amountIn,
            amountOutMinimum: params.amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    };
  }
}

/** Project a route onto the wire `Quote` the API and worker already exchange. */
export function toQuote(route: RouteQuote): Quote {
  return {
    token_in: route.tokenIn,
    token_out: route.tokenOut,
    amount_in: route.amountIn.toString(),
    amount_out: route.amountOut.toString(),
    min_out: route.minOut.toString(),
    tick_spacing: route.tickSpacing,
    expires_at: new Date(route.expiresAt).toISOString(),
    reference: route.referencePrice,
  };
}
