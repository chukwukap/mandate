import { parseAbi } from "viem";

/**
 * Chainlink AggregatorV3Interface, as deployed for the Coinbase B20 tokenized-equity
 * feeds on Base (e.g. AAPLc/USD 0x787f13dEa48Db0897CbCDD985de77809D837F988).
 *
 * `answer` is int256 and signed on purpose. A negative or zero answer is a live
 * aggregator fault, not an impossible value, so callers must reject it rather than
 * cast it to an unsigned type and quote against garbage — see feeds/staleness.ts.
 *
 * `decimals()` is read, never assumed: these equity feeds report 8 decimals while the
 * USDC leg of every trade is 6 and AAPLc itself is 8. Hardcoding 18 anywhere in this
 * path mis-sizes an order by 10^10.
 */
export const aggregatorV3Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function version() view returns (uint256)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);
