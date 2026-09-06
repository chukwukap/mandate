import type { Asset } from "@mandate/contracts";
// Source: Chainlink Coinbase B20 catalogue, cross-checked against token metadata.
// The client rechecks metadata and supply; presence here never implies liquidity.
export const ASSETS: readonly Asset[] = [
  {
    symbol: "AAPLc",
    token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    feed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    decimals: 8,
  },
  {
    symbol: "GOOGLc",
    token: "0xb2000000000000000000002D0BA3164cc74f58B7",
    feed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    decimals: 8,
  },
  {
    symbol: "METAc",
    token: "0xb2000000000000000000008bC8786B856E61707C",
    feed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    decimals: 8,
  },
  {
    symbol: "NVDAc",
    token: "0xb20000000000000000000078ee7ce2fE4908108C",
    feed: "0x04689a41629776563E6822F76f2e57D148d28513",
    decimals: 8,
  },
  {
    symbol: "MSFTc",
    token: "0xB200000000000000000000Ab99cFa739E253872B",
    feed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
    decimals: 8,
  },
  {
    symbol: "AMZNc",
    token: "0xb200000000000000000000d9192b6B456483C2E8",
    feed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
    decimals: 8,
  },
  {
    symbol: "TSLAc",
    token: "0xb2000000000000000000001e800a7f5189430cD0",
    feed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
    decimals: 8,
  },
];
export const QUOTER = "0x514c8B5f54112481E28028F1166Bd78501089259" as const;
export const TICK_SPACINGS = [100, 200, 2000, 50, 10, 1] as const;
