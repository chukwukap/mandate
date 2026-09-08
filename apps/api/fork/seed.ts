/**
 * Make a forked Base usable: put executable ERC20s at the seven B20 addresses, back every real
 * pool with the balance it holds on mainnet, and stand up a funded Coinbase Smart Wallet.
 *
 * The token balances are copied from mainnet rather than invented. Each Slipstream pool's own
 * slot0, liquidity and tick bitmap come from the fork and are real; a pool whose reserves did
 * not match that internal state would quote correctly and then fail to pay out.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseAbi,
  stringToHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { ASSETS } from "../../../packages/evm/src/index.js";

const LOCAL = "http://127.0.0.1:8545";
// Reads of the real B20 balances have to go to a node that can actually execute the precompile,
// and to a different endpoint than the one anvil is forking from, which is already busy.
const READ = process.env.FORK_READ_RPC ?? "https://base-rpc.publicnode.com";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACTORY = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const WALLET_FACTORY = "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a";
const SPEND_MANAGER = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
const SPACINGS = [100, 200, 2000, 50, 10, 1];
/** anvil #0 deploys, anvil #1 owns the smart wallet. */
const DEPLOYER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../infra/fork/${name}.json`, import.meta.url), "utf8"));
const artifact = load("B20Mock");
const ORACLE_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";

/** Deploy, then move the runtime code to the address the product already knows. */
async function install(name: string, at: `0x${string}`, abiArgs: unknown[] = []) {
  const art = load(name);
  const hash = await wallet.deployContract({
    abi: art.abi,
    bytecode: art.bytecode.object as `0x${string}`,
    args: abiArgs as never,
  });
  const { contractAddress } = await local.waitForTransactionReceipt({ hash });
  await rpc("anvil_setCode", [at, await runtimeCode(contractAddress)]);
}
const local = createPublicClient({ chain: base, transport: http(LOCAL) });
const read = createPublicClient({ chain: base, transport: http(READ) });
const wallet = createWalletClient({ account: DEPLOYER, chain: base, transport: http(LOCAL) });
const rpc = (method: string, params: unknown[]) =>
  fetch(LOCAL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function mint(address,uint256)",
]);
const factoryAbi = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const walletFactoryAbi = parseAbi([
  "function createAccount(bytes[] owners, uint256 nonce) payable returns (address)",
  "function getAddress(bytes[] owners, uint256 nonce) view returns (address)",
]);

/** A deployment receipt without an address means the deploy reverted, so say that rather than
 *  moving `undefined` onto a live address and failing later with no clue why. */
async function runtimeCode(address: `0x${string}` | null | undefined) {
  if (!address) throw new Error("Contract deployment produced no address");
  const code = await local.getCode({ address });
  if (!code || code === "0x") throw new Error(`No runtime code at ${address}`);
  return code;
}

/** USDC (FiatTokenV2_2) keeps balances in mapping slot 9. */
async function fundUsdc(who: `0x${string}`, whole: bigint) {
  const slot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]),
  );
  await rpc("anvil_setStorageAt", [USDC, slot, pad(toHex(whole * 1_000_000n), { size: 32 })]);
}

for (const asset of ASSETS) {
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
    args: [stringToHex(asset.symbol, { size: 32 })],
  });
  const { contractAddress } = await local.waitForTransactionReceipt({ hash });
  // The identity lives in an immutable, which is part of the runtime code, so moving the code
  // moves the symbol with it and no storage has to be reconstructed.
  await rpc("anvil_setCode", [asset.token, await runtimeCode(contractAddress)]);

  const seeded: string[] = [];
  for (const spacing of SPACINGS) {
    await new Promise((r) => setTimeout(r, 200));
    const pool = await read.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [asset.token, USDC, spacing],
    });
    if (pool === "0x0000000000000000000000000000000000000000") continue;
    const held = await read.readContract({
      address: asset.token,
      abi: erc20,
      functionName: "balanceOf",
      args: [pool],
    });
    if (held === 0n) continue;
    await wallet.writeContract({
      address: asset.token,
      abi: erc20,
      functionName: "mint",
      args: [pool, held],
    });
    seeded.push(`ts=${spacing}`);
  }
  console.log(`${asset.symbol.padEnd(7)} ${asset.token} pools[${seeded.join(",")}]`);
}

// A real Base Account. Registering the SpendPermissionManager as an owner is what makes
// walletKind() report `base_account`, and it is the same registration the wallet performs when a
// user first grants a spend permission.
const owners = [pad(OWNER.address, { size: 32 }), pad(SPEND_MANAGER, { size: 32 })];
const account = await local.readContract({
  address: WALLET_FACTORY,
  abi: walletFactoryAbi,
  functionName: "getAddress",
  args: [owners, 0n],
});
if ((await local.getCode({ address: account })) === undefined) {
  const hash = await wallet.writeContract({
    address: WALLET_FACTORY,
    abi: walletFactoryAbi,
    functionName: "createAccount",
    args: [owners, 0n],
  });
  await local.waitForTransactionReceipt({ hash });
}
await fundUsdc(account, 10_000n);
await fundUsdc(DEPLOYER.address, 10_000n);
await rpc("anvil_setBalance", [account, "0x8AC7230489E80000"]);
await rpc("anvil_setBalance", [
  "0xF77ff4D88fcFaF229391C4BB9465AAbbac892de0",
  "0x56BC75E2D63100000",
]);
// Base's registries and the Chainlink feeds. The registries are precompiles like the tokens.
// The feeds are ordinary contracts and fork perfectly, but a pinned block freezes `updatedAt`,
// and the worker refuses any reference older than 300 seconds — so each feed is replaced by one
// carrying the same answer it had at the forked block with a live timestamp.
await install("OracleRegistryMock", ORACLE_REGISTRY);
await install("PolicyRegistryMock", POLICY_REGISTRY);
for (const asset of ASSETS) {
  const answer = await read.readContract({
    address: asset.feed,
    abi: parseAbi(["function latestAnswer() view returns (int256)"]),
    functionName: "latestAnswer",
  });
  await install("FeedMock", asset.feed, [answer]);
  await new Promise((r) => setTimeout(r, 150));
}
console.log("oracle registry, policy registry and 7 Chainlink feeds installed");

console.log(`smart wallet ${account} funded with 10,000 USDC; spender funded with 100 ETH`);
