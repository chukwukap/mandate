/**
 * Give an address spendable balances on the forked chain.
 *
 * A tester signs in with their own wallet, which on a fork holds nothing. USDC is written
 * straight into its balance slot rather than transferred, so no whale needs impersonating and
 * the ledger stays self-consistent.
 *
 * Usage: bun run apps/api/fork/fund-user.ts 0xYourAddress [usdc]
 */
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
} from "viem";
import { base } from "viem/chains";

const LOCAL = "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const address = process.argv[2] as `0x${string}` | undefined;
const dollars = BigInt(process.argv[3] ?? "10000");
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error("Usage: bun run apps/api/fork/fund-user.ts 0xYourAddress [usdc]");
  process.exit(1);
}

const pub = createPublicClient({ chain: base, transport: http(LOCAL) });
const rpc = (method: string, params: unknown[]) =>
  fetch(LOCAL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

// USDC (FiatTokenV2_2) keeps balances in mapping slot 9.
const slot = keccak256(
  encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [address, 9n]),
);
await rpc("anvil_setStorageAt", [USDC, slot, pad(toHex(dollars * 1_000_000n), { size: 32 })]);
await rpc("anvil_setBalance", [address, "0x8AC7230489E80000"]);

const balance = await pub.readContract({
  address: USDC,
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [address],
});
const eth = await pub.getBalance({ address });
console.log(`${address}`);
console.log(`  USDC ${Number(balance) / 1e6}`);
console.log(`  ETH  ${Number(eth) / 1e18}`);

// A wallet that is not a Coinbase Smart Wallet cannot hold a spend permission, so automatic
// mode will refuse at the approval step. Saying so here beats discovering it after signing.
const code = await pub.getCode({ address });
if (!code || code === "0x")
  console.log(
    "\n  NOTE: this is a plain EOA, so automatic buying will be refused at the approval step\n" +
      "  (spend permissions need a Coinbase Smart Wallet). Signal-only strategies work fully.",
  );
