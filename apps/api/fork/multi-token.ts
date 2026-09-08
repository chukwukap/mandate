/** Drives one multi-token strategy from draft to filled orders. See ./e2e.ts for what is real. */
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

const RPC = "http://127.0.0.1:8545";
const pub = createPublicClient({ chain: base, transport: http(RPC) });
const owner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const relayer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const relay = createWalletClient({ account: relayer, chain: base, transport: http(RPC) });

const SYMBOLS = ["AAPLc", "NVDAc", "TSLAc"];
const TOKENS: Record<string, Hex> = {
  AAPLc: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  NVDAc: "0xb20000000000000000000078ee7ce2fE4908108C",
  TSLAc: "0xb2000000000000000000001e800a7f5189430cD0",
};
type Hex = `0x${string}`;
/** Named lookups so a typo in a symbol fails here instead of as a silent undefined address. */
function token(symbol: string): Hex {
  const found = TOKENS[symbol];
  if (!found) throw new Error(`No token address for ${symbol}`);
  return found;
}
function at(list: readonly string[], index: number): string {
  const found = list[index];
  if (found === undefined) throw new Error(`No symbol at index ${index}`);
  return found;
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const headers = { authorization: "Bearer fork" };

/** Coinbase Smart Wallet: replay-safe envelope, then a SignatureWrapper naming the owner. */
async function sign(hash: Hex): Promise<Hex> {
  const safe = await pub.readContract({
    address: ACCOUNT,
    abi: parseAbi(["function replaySafeHash(bytes32) view returns (bytes32)"]),
    functionName: "replaySafeHash",
    args: [hash],
  });
  const signature = await owner.sign({ hash: safe });
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
    [{ ownerIndex: 0n, signatureData: signature }],
  );
}

const { app, close } = await boot();
const step = (n: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "  ok " : "FAIL "} ${n}${detail ? ` — ${detail}` : ""}`);

try {
  const before = Object.fromEntries(
    await Promise.all(
      SYMBOLS.map(
        async (s) =>
          [
            s,
            await pub.readContract({
              address: token(s),
              abi: erc20,
              functionName: "balanceOf",
              args: [ACCOUNT],
            }),
          ] as const,
      ),
    ),
  );

  // 1. Draft a basket. Thresholds are far above spot so all three conditions are true on the
  //    first tick — the point here is the pipeline, not the timing.
  const plan = {
    nodes: SYMBOLS.map((s) => ({
      id: `target_${s}`,
      op: "lt",
      args: [
        { kind: "feed", feed: `oracle:${s}` },
        { kind: "const", value: "100000" },
      ],
    })),
    machines: SYMBOLS.map((s, i) => ({
      id: `entry_${s}`,
      scope: "portfolio",
      initial: "watching",
      states: [
        {
          id: "watching",
          transitions: [
            {
              when: `target_${s}`,
              to: "watching",
              actions: [
                { action: "order", asset: i, side: "buy", size: { unit: "quote", value: "25" } },
              ],
            },
          ],
        },
      ],
    })),
  };
  const caps = {
    lifetime: "300",
    per_order: "25",
    per_period: "150",
    period_secs: 86400,
    max_orders_per_period: 10,
    cooldown_secs: 0,
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    slippage_bps: 300,
  };
  const draft = await app.inject({
    method: "POST",
    url: "/v1/strategies/draft",
    headers,
    payload: { name: "Three stock basket", mode: "auto", plan, caps, assets: SYMBOLS },
  });
  step("draft accepted", draft.statusCode === 201, `${draft.statusCode}`);
  if (draft.statusCode !== 201) {
    console.log(draft.body.slice(0, 400));
    throw new Error("draft");
  }
  const d = draft.json();
  step("index mapping disclosed", d.card.cautions.join("\n").includes("0=AAPLc, 1=NVDAc, 2=TSLAc"));
  step("simultaneous firing disclosed", d.card.cautions.join("\n").includes("3 rules can trigger"));

  // 2. Sign the review through the smart wallet and arm it.
  const created = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: d.artifact_id, signature: await sign(hashMessage(d.confirm_message)) },
  });
  step("ERC-1271 review signature accepted", created.statusCode === 201, `${created.statusCode}`);
  if (created.statusCode !== 201) {
    console.log(created.body.slice(0, 400));
    throw new Error("create");
  }
  const instance = created.json().instance;

  // 3. Spend permission: prepare, sign the EIP-712, submit.
  const prep = await app.inject({
    method: "POST",
    url: "/v1/permissions/prepare",
    headers,
    payload: { instance },
  });
  step(
    "permission prepared",
    prep.statusCode === 200 || prep.statusCode === 201,
    `${prep.statusCode}`,
  );
  if (prep.statusCode >= 400) {
    console.log(prep.body.slice(0, 500));
    throw new Error("prepare");
  }
  const prepared = prep.json();
  const typed = prepared.typed_data ?? prepared.typedData ?? prepared;
  const permissionSig = await sign(
    hashTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    }),
  );
  const granted = await app.inject({
    method: "POST",
    url: "/v1/permissions",
    headers,
    payload: { instance, signature: permissionSig },
  });
  step(
    "permission signature verified onchain",
    granted.statusCode === 200 || granted.statusCode === 201,
    `${granted.statusCode}`,
  );
  if (granted.statusCode >= 400) {
    console.log(granted.body.slice(0, 500));
    throw new Error("grant");
  }

  // 4. Approve it onchain. The call is the one the API handed back, relayed as-is.
  const call = granted.json().approval_call;
  const hash = await relay.sendTransaction({
    to: call.to as Hex,
    data: call.data as Hex,
    value: 0n,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  step("approval mined", receipt.status === "success", `gas=${receipt.gasUsed}`);

  const active = await app.inject({
    method: "POST",
    url: `/v1/instances/${instance}/permission/activate`,
    headers,
    payload: { enable_auto: true },
  });
  step("permission active", active.statusCode < 400, `${active.statusCode}`);
  if (active.statusCode >= 400) console.log(active.body.slice(0, 400));
  // Activating the permission grants authority; it does not start the strategy. A signed,
  // approved, automatic instance still sits paused until it is armed, which is the last thing
  // standing between a user's signature and the worker spending against it.
  const arm = await app.inject({ method: "POST", url: `/v1/instances/${instance}/arm`, headers });
  step("armed", arm.statusCode < 400, `${arm.statusCode}`);
  if (arm.statusCode >= 400) console.log(arm.body.slice(0, 300));

  const armed = await app.inject({ url: `/v1/instances/${instance}`, headers });
  const state = armed.json();
  step(
    "instance armed in automatic mode",
    state.mode === "auto" && state.status === "armed",
    `mode=${state.mode} status=${state.status}`,
  );

  // 5. Hand over to the worker, which is a separate process on the same database.
  console.log("\nwaiting for the worker…");
  let filled = 0;
  for (let i = 0; i < 60 && filled < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const now = await Promise.all(
      SYMBOLS.map(async (s) =>
        pub.readContract({
          address: token(s),
          abi: erc20,
          functionName: "balanceOf",
          args: [ACCOUNT],
        }),
      ),
    );
    filled = now.filter((v, k) => v > (before[at(SYMBOLS, k)] ?? 0n)).length;
    const ex = await app.inject({ url: `/v1/instances/${instance}/executions`, headers });
    const rows: { status: string }[] = ex.statusCode === 200 ? (ex.json().executions ?? []) : [];
    process.stdout.write(
      `\r  t+${(i + 1) * 5}s  filled=${filled}/3  executions=${rows.length}  ${rows.map((r) => r.status).join(",")}        `,
    );
  }
  console.log();

  const after = await Promise.all(
    SYMBOLS.map(async (s) =>
      pub.readContract({
        address: token(s),
        abi: erc20,
        functionName: "balanceOf",
        args: [ACCOUNT],
      }),
    ),
  );
  for (const [i, s] of SYMBOLS.entries())
    step(
      `${s} position opened`,
      Number(after[i] ?? 0n) > Number(before[s] ?? 0n),
      `${Number(after[i] ?? 0n) / 1e8} ${s}`,
    );

  const evals = await app.inject({ url: `/v1/instances/${instance}/evaluations`, headers });
  console.log(
    "\nevaluations:",
    evals.statusCode === 200 ? JSON.stringify(evals.json()).slice(0, 500) : evals.statusCode,
  );
} finally {
  await close();
}
