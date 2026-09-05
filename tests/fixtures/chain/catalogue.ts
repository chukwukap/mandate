import type { Asset } from "../../../packages/contracts/src/index.js";
import { ASSETS, QUOTER, TICK_SPACINGS } from "../../../packages/evm/src/addresses/index.js";
import { CHAIN_ID, SPEND_MANAGER, USDC } from "../../../packages/evm/src/permissions/index.js";
import {
  SLIPSTREAM_FACTORY,
  SLIPSTREAM_SWAP_ROUTER,
} from "../../../packages/evm/src/venues/slipstream.js";

/**
 * Base mainnet identity for every chain fixture.
 *
 * Re-exported from the packages rather than restated. A fixture that carried its own copy of
 * the quoter address or the probe set would keep passing after production changed either one,
 * which is the one thing a fixture must never do.
 */
export {
  CHAIN_ID,
  QUOTER,
  SLIPSTREAM_FACTORY,
  SLIPSTREAM_SWAP_ROUTER,
  SPEND_MANAGER,
  TICK_SPACINGS,
  USDC,
};

/** USDC is the quote leg of every B20 pair, and it has six decimals — not eighteen. */
export const USDC_DECIMALS = 6;

/**
 * Chainlink's USD equity feeds answer at 8 decimals, so a $320.08 NAV is 32_008_000_000.
 * Every recorded round below is written at this scale.
 */
export const FEED_DECIMALS = 8;

export type FixtureAsset = Asset & {
  /**
   * True when `packages/evm`'s shipped catalogue lists this token. The three that are false
   * are real, deployed B20 equities that this system does not route today: they exist here so
   * the "asset the user can name but the venue cannot fill" path has something concrete to
   * point at, instead of an invented address that would never behave like a real token.
   */
  readonly shipped: boolean;
};

/**
 * The Coinbase B20 tokenized equities on Base, with their Chainlink reference feeds.
 *
 * EVERY B20 equity is 8 decimals. Assuming the ERC20 default of 18 misprices an order by
 * 1e10 — a $10 buy becomes a $100,000,000,000 buy — so the scale is spelled out on each entry
 * and asserted against the shipped catalogue in `catalogue.test.ts`.
 */
export const B20_ASSETS: readonly FixtureAsset[] = [
  {
    symbol: "AAPLc",
    token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    feed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    decimals: 8,
    shipped: true,
  },
  {
    symbol: "GOOGLc",
    token: "0xb2000000000000000000002D0BA3164cc74f58B7",
    feed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    decimals: 8,
    shipped: true,
  },
  {
    symbol: "METAc",
    token: "0xb2000000000000000000008bC8786B856E61707C",
    feed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    decimals: 8,
    shipped: true,
  },
  {
    symbol: "NVDAc",
    token: "0xb20000000000000000000078ee7ce2fE4908108C",
    feed: "0x04689a41629776563E6822F76f2e57D148d28513",
    decimals: 8,
    shipped: true,
  },
  {
    symbol: "MSFTc",
    token: "0xB200000000000000000000Ab99cFa739E253872B",
    feed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
    decimals: 8,
    shipped: false,
  },
  {
    symbol: "AMZNc",
    token: "0xb200000000000000000000d9192b6B456483C2E8",
    feed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
    decimals: 8,
    shipped: false,
  },
  {
    symbol: "TSLAc",
    token: "0xb2000000000000000000001e800a7f5189430cD0",
    feed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
    decimals: 8,
    shipped: false,
  },
];

/** The four assets `packages/evm` actually routes. Same objects, minus the fixture flag. */
export const SHIPPED_ASSETS: readonly Asset[] = ASSETS;

/**
 * Look an asset up by symbol, throwing rather than returning undefined.
 *
 * `noUncheckedIndexedAccess` makes every lookup optional, and a fixture that silently
 * substitutes a default asset is how a test ends up asserting against the wrong token.
 */
export function assetOf(symbol: string): FixtureAsset {
  const asset = B20_ASSETS.find((entry) => entry.symbol === symbol);
  if (!asset) throw new Error(`No fixture asset for ${symbol}`);
  return asset;
}

/** Strip the fixture-only flag, for callers that want the exact wire `Asset` shape. */
export function plainAsset(asset: FixtureAsset): Asset {
  return { symbol: asset.symbol, token: asset.token, feed: asset.feed, decimals: asset.decimals };
}
