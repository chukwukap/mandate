import { parseAbi } from "viem";

/**
 * Aerodrome Slipstream on Base.
 *
 * Slipstream is a Uniswap V3 fork with one difference that breaks naive ABI reuse: pools
 * are keyed by `int24 tickSpacing`, NOT by `uint24 fee`. The fee is derived from the tick
 * spacing by the factory. So `getPool(address,address,int24)` is selector 0x28af8d0b while
 * Uniswap V3's `getPool(address,address,uint24)` is 0x1698ee82, and Slipstream's
 * `exactInputSingle` param struct has no `fee` member at all. Pasting a Uniswap V3 ABI
 * here compiles, encodes a different selector, and reverts on mainnet with no useful
 * message. test/abis.test.ts pins these selectors for that reason.
 */

/** CLFactory 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef. */
export const clFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)",
  "function tickSpacingToFee(int24 tickSpacing) view returns (uint24 fee)",
  "function poolImplementation() view returns (address)",
]);

/**
 * CLPool reads used for diagnostics.
 *
 * Only single-value returns are declared. `slot0()` is deliberately absent: its tuple
 * layout differs between Uniswap V3 and Slipstream, and a wrong layout does not revert —
 * it decodes the neighbouring word and silently reports the wrong price. Routing never
 * needs it, because QuoterV2 already prices the swap and feeds/ provides the independent
 * reference. Add it only after decoding a real mainnet response field by field.
 */
export const clPoolAbi = parseAbi([
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
]);

/**
 * QuoterV2 0x514c8B5f54112481E28028F1166Bd78501089259.
 *
 * `quoteExactInputSingle` is nonpayable, not view — it executes the swap and reverts to
 * unwind. It must be reached through `simulateContract`; `readContract` will not work.
 * `initializedTicksCrossed` is returned and worth surfacing: a quote that crossed many
 * ticks in a thin pool is the shape of the tick-spacing trap, though the Chainlink band,
 * not the tick count, is what actually admits or rejects the route.
 */
export const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

/**
 * SwapRouter 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F.
 *
 * Note the param struct: tickSpacing sits where Uniswap V3 puts `fee`, and there is no
 * separate fee field. Transcribed from the deployed contract and already exercised by
 * apps/worker/src/chain.ts.
 */
export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
