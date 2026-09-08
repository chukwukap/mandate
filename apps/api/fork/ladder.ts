/**
 * The step ladder, end to end, with the price actually walked down through every rung.
 *
 * The point is the escalation. Each rung buys more than the last, so the deepest rung is the one
 * a per-order cap sized from the OPENING amount would silently refuse — the strategy would look
 * armed, fill once, and do nothing on exactly the falls it exists for. Proving the last rung
 * fills is proving that cap is derived correctly.
 *
 * The oracle is walked by reinstalling the feed stand-in at a lower answer, which is the only
 * way to move a price on a pinned fork. See ./e2e.ts for what is substituted and why.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  hashMessage,
  hashTypedData,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { ACCOUNT, boot } from "./e2e.js";

type Hex = `0x${string}`;
const RPC = "http://127.0.0.1:8545";
const AAPL: Hex = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const FEED: Hex = "0x787f13dEa48Db0897CbCDD985de77809D837F988";
const pub = createPublicClient({ chain: base, transport: http(RPC) });
const owner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const deployer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const wallet = createWalletClient({ account: deployer, chain: base, transport: http(RPC) });
const feedArtifact = JSON.parse(
  readFileSync(new URL("../../../infra/fork/FeedMock.json", import.meta.url), "utf8"),
);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const headers = { authorization: "Bearer fork" };
const step = (n: string, ok: boolean, d = "") =>
  console.log(`${ok ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`);
const rpc = (m: string, p: unknown[]) =>
  fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
  }).then((r) => r.json());

async function setPrice(dollars: number) {
  const hash = await wallet.deployContract({
    abi: feedArtifact.abi,
    bytecode: feedArtifact.bytecode.object as Hex,
    args: [BigInt(Math.round(dollars * 1e8))],
  });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
  await rpc("anvil_setCode", [FEED, await pub.getCode({ address: contractAddress as Hex })]);
}

async function sign(hash: Hex): Promise<Hex> {
  const safe = await pub.readContract({
    address: ACCOUNT,
    abi: parseAbi(["function replaySafeHash(bytes32) view returns (bytes32)"]),
    functionName: "replaySafeHash",
    args: [hash],
  });
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "ownerIndex", type: "uint256" },
          { name: "signatureData", type: "bytes" },
        ],
      },
    ],
    [{ ownerIndex: 0n, signatureData: await owner.sign({ hash: safe }) }],
  );
}

/**
 * Rungs deliberately close together.
 *
 * Only the ORACLE can be walked on a pinned fork; the pool keeps quoting whatever its reserves
 * say. Routing rejects any quote more than 500 bps from the reference, so marching the oracle
 * far below a static pool manufactures a dislocation the system is built to refuse — a first
 * attempt with rungs at 310/300/290/280 filled rung one and then reported "Missing market
 * observation" three times, which was the deviation guard working, not the ladder failing.
 *
 * A ~1.5% total walk keeps pool and oracle inside that tolerance, so what is under test is the
 * ladder's escalation rather than the venue's safety check.
 */
const RUNGS = [
  { price: "315", amount: "20" },
  { price: "314", amount: "40" },
  { price: "313", amount: "80" },
  { price: "312", amount: "160" },
];
const held = () =>
  pub.readContract({ address: AAPL, abi: erc20, functionName: "balanceOf", args: [ACCOUNT] });

const { app, close } = await boot();
const relay = createWalletClient({ account: deployer, chain: base, transport: http(RPC) });

try {
  await setPrice(316);
  const plan = {
    nodes: RUNGS.map((r, i) => ({
      id: `step_${i}`,
      op: "lt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: r.price },
      ],
    })),
    machines: [
      {
        id: "ladder_AAPLc",
        scope: "portfolio",
        initial: "rung0",
        states: [
          ...RUNGS.map((r, i) => ({
            id: `rung${i}`,
            transitions: [
              {
                when: `step_${i}`,
                fires: "on_edge",
                to: i + 1 < RUNGS.length ? `rung${i + 1}` : "spent",
                actions: [
                  {
                    action: "order",
                    asset: 0,
                    side: "buy",
                    size: { unit: "quote", value: r.amount },
                  },
                ],
              },
            ],
          })),
          { id: "spent", transitions: [] },
        ],
      },
    ],
  };
  // per_order is the LARGEST rung. Sized from the opening 20 instead, rungs 2-4 would be
  // refused by the envelope and this whole test would stall after the first fill.
  const caps = {
    lifetime: "400",
    per_order: "160",
    per_period: "400",
    period_secs: 86_400,
    max_orders_per_period: 50,
    cooldown_secs: 0,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    slippage_bps: 400,
  };

  const draft = await app.inject({
    method: "POST",
    url: "/v1/strategies/draft",
    headers,
    payload: { name: "Apple step ladder", mode: "auto", plan, caps, assets: ["AAPLc"] },
  });
  if (draft.statusCode !== 201)
    throw new Error(`draft ${draft.statusCode}: ${draft.body.slice(0, 400)}`);
  const d = draft.json();
  step("ladder drafted", true, `${d.card.rules.length} rules`);

  const created = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: d.artifact_id, signature: await sign(hashMessage(d.confirm_message)) },
  });
  const instance = created.json().instance;
  const prep = await app.inject({
    method: "POST",
    url: "/v1/permissions/prepare",
    headers,
    payload: { instance },
  });
  const typed = prep.json().typed_data ?? prep.json();
  const granted = await app.inject({
    method: "POST",
    url: "/v1/permissions",
    headers,
    payload: {
      instance,
      signature: await sign(
        hashTypedData({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        }),
      ),
    },
  });
  const call = granted.json().approval_call;
  await pub.waitForTransactionReceipt({
    hash: await relay.sendTransaction({ to: call.to as Hex, data: call.data as Hex, value: 0n }),
  });
  await app.inject({
    method: "POST",
    url: `/v1/instances/${instance}/permission/activate`,
    headers,
    payload: { enable_auto: true },
  });
  await app.inject({ method: "POST", url: `/v1/instances/${instance}/arm`, headers });
  step("ladder armed", true, instance.slice(0, 8));

  // Above every rung: the ladder must sit still.
  const idle = await held();
  await new Promise((r) => setTimeout(r, 20_000));
  step("holds while the price is above the first step", (await held()) === idle);

  // Walk down. Each stop should fill exactly one rung, each larger than the last.
  const fills: number[] = [];
  for (const [i, price] of [314.5, 313.5, 312.5, 311.5].entries()) {
    await setPrice(price);
    const before = await held();
    let after = before;
    for (let t = 0; t < 24 && after === before; t += 1) {
      await new Promise((r) => setTimeout(r, 5_000));
      after = await held();
      process.stdout.write(`\r  $${price} rung ${i + 1}/4 waiting ${(t + 1) * 5}s   `);
    }
    console.log();
    const shares = Number(after - before) / 1e8;
    fills.push(shares * price);
    step(
      `rung ${i + 1} filled at $${price}`,
      after > before,
      `${shares.toFixed(6)} AAPLc ≈ $${(shares * price).toFixed(2)}`,
    );
  }

  const rounded = fills.map((v) => Math.round(v / 10) * 10);
  step(
    "each rung spent more than the one before",
    rounded.every((v, i) => i === 0 || v > (rounded[i - 1] as number)),
    rounded.map((v) => `$${v}`).join(" -> "),
  );

  // Terminal: past the last rung there is nothing left to fire, and nothing here can sell.
  await setPrice(310.5);
  const done = await held();
  await new Promise((r) => setTimeout(r, 40_000));
  step("stops after the last step instead of buying forever", (await held()) === done);
} finally {
  await close();
}
