import type { Asset, MarketFeed } from "@mandate/contracts";
export type Market = { assets: Asset[]; feeds: MarketFeed[]; execution_available: boolean };
