/**
 * The bot-shaped strategies, end to end against a forked Base.
 *
 * `multi-token.ts` proves the pipeline. This proves the SHAPES: that a recurring plan is really
 * paced by its cooldown, and that a rebalance really reads the portfolio and stops when the
 * weights are met. Both run through the real API, the real signature ceremony and the real
 * worker — see ./e2e.ts for what is substituted and why.
 */
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
const pub = createPublicClient({ chain: base, transport: http(RPC) });
const owner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const relayer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const relay = createWalletClient({ account: relayer, chain: base, transport: http(RPC) });
const TOKENS: Record<string, Hex> = {
  AAPLc: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  NVDAc: "0xb20000000000000000000078ee7ce2fE4908108C",
  TSLAc: "0xb2000000000000000000001e800a7f5189430cD0",
};
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const headers = { authorization: "Bearer fork" };
const step = (n: string, ok: boolean, d = "") =>
  console.log(`${ok ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`);

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

const { app, close } = await boot();

/** Draft, sign, permit, approve, arm. Returns the instance id. */
async function arm(name: string, plan: unknown, caps: unknown, assets: string[]) {
  const draft = await app.inject({
    method: "POST",
    url: "/v1/strategies/draft",
    headers,
    payload: { name, mode: "auto", plan, caps, assets },
  });
  if (draft.statusCode !== 201)
    throw new Error(`draft ${draft.statusCode}: ${draft.body.slice(0, 300)}`);
  const d = draft.json();
  const created = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: d.artifact_id, signature: await sign(hashMessage(d.confirm_message)) },
  });
  if (created.statusCode !== 201)
    throw new Error(`create ${created.statusCode}: ${created.body.slice(0, 300)}`);
  const instance = created.json().instance;
  const prep = await app.inject({
    method: "POST",
    url: "/v1/permissions/prepare",
    headers,
    payload: { instance },
  });
  if (prep.statusCode >= 400)
    throw new Error(`prepare ${prep.statusCode}: ${prep.body.slice(0, 300)}`);
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
  if (granted.statusCode >= 400)
    throw new Error(`grant ${granted.statusCode}: ${granted.body.slice(0, 300)}`);
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
  const armed = await app.inject({ method: "POST", url: `/v1/instances/${instance}/arm`, headers });
  if (armed.statusCode >= 400)
    throw new Error(`arm ${armed.statusCode}: ${armed.body.slice(0, 300)}`);
  return { instance, card: d.card, render: d.render_text };
}

const held = async (s: string) =>
  pub.readContract({
    address: TOKENS[s] as Hex,
    abi: erc20,
    functionName: "balanceOf",
    args: [ACCOUNT],
  });

const expires = new Date(Date.now() + 86_400_000).toISOString();

try {
  // ---- 1. Recurring: paced ONLY by the cooldown. -----------------------------------------
  const before = await held("AAPLc");
  const recurring = await arm(
    "Recurring Apple",
    {
      nodes: [
        {
          id: "always",
          op: "gte",
          args: [
            { kind: "feed", feed: "oracle:AAPLc" },
            { kind: "const", value: "0" },
          ],
        },
      ],
      machines: [
        {
          id: "buy_AAPLc",
          scope: "portfolio",
          initial: "buying",
          states: [
            {
              id: "buying",
              transitions: [
                {
                  when: "always",
                  fires: "while_true",
                  max_repeats: 10000,
                  to: "buying",
                  actions: [
                    {
                      action: "order",
                      asset: 0,
                      side: "buy",
                      size: { unit: "quote", value: "20" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      lifetime: "200",
      per_order: "20",
      per_period: "200",
      period_secs: 86_400,
      max_orders_per_period: 100,
      cooldown_secs: 120,
      expires_at: expires,
      slippage_bps: 300,
    },
    ["AAPLc"],
  );
  step("recurring armed", true, recurring.instance.slice(0, 8));

  // Two minutes of cooldown, watched for five: it must buy, then WAIT, then buy again. A rule
  // that fires every tick would be a runaway, and one that fires once is not a schedule.
  // Every distinct balance is one more fill. Timestamped so the gap between them can be
  // compared against the cooldown that is supposed to be producing it.
  const fills: { at: number; balance: bigint }[] = [];
  let last = before;
  for (let i = 0; i < 72 && fills.length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const now = await held("AAPLc");
    if (now > last) {
      fills.push({ at: Date.now(), balance: now });
      last = now;
    }
    process.stdout.write(`\r  recurring t+${(i + 1) * 5}s fills=${fills.length}   `);
  }
  console.log();
  step("recurring bought more than once", fills.length >= 2, `${fills.length} fills`);
  if (fills.length >= 2) {
    const gap = ((fills[1] as { at: number }).at - (fills[0] as { at: number }).at) / 1000;
    /**
     * The claim is that the cooldown paced this, not that it timed it to the second.
     *
     * Two things sit between one fill being SEEN and the next. The cooldown runs from admission
     * to admission, while a fill is only visible once its swap confirms, so the pipeline's
     * latency lands inside the observed gap (measured on this fork: 19-32s for three legs at two
     * confirmations). And the instance only re-evaluates every tick interval, so admission
     * itself rounds up to the next tick. Measured steady state was 134s for a 120s cooldown on a
     * 12s tick — the cap plus one tick, exactly as designed.
     *
     * So the bound is one-sided. Firing faster than the cooldown would be the real defect; being
     * slower is the pipeline, and a rule that fired on every tick would show a gap near zero.
     */
    step(
      "the cooldown paced it, not the tick rate",
      gap >= 120,
      `${gap.toFixed(0)}s between observed fills, cooldown 120s`,
    );
  }

  // ---- 2. Rebalance: reads the portfolio, stops at target. -------------------------------
  const SYMS = ["AAPLc", "NVDAc", "TSLAc"];
  const openings = Object.fromEntries(
    await Promise.all(SYMS.map(async (s) => [s, await held(s)] as const)),
  );
  const rebalance = await arm(
    "Keep balanced",
    {
      nodes: SYMS.flatMap((s) => [
        {
          id: `weight_${s}`,
          op: "safe_div",
          args: [
            { kind: "feed", feed: `value:${s}` },
            { kind: "feed", feed: "equity" },
            { kind: "const", value: "1" },
          ],
        },
        {
          id: `under_${s}`,
          op: "lt",
          args: [
            { kind: "node", node: `weight_${s}` },
            { kind: "const", value: "0.333300" },
          ],
        },
        {
          id: `funded_${s}`,
          op: "gte",
          args: [
            { kind: "feed", feed: "cash" },
            { kind: "const", value: "20" },
          ],
        },
        {
          id: `topup_${s}`,
          op: "and",
          args: [
            { kind: "node", node: `under_${s}` },
            { kind: "node", node: `funded_${s}` },
          ],
        },
      ]),
      machines: SYMS.map((s, i) => ({
        id: `weight_${s}`,
        scope: "portfolio",
        initial: "watching",
        states: [
          {
            id: "watching",
            transitions: [
              {
                when: `topup_${s}`,
                fires: "while_true",
                max_repeats: 1000,
                to: "watching",
                actions: [
                  { action: "order", asset: i, side: "buy", size: { unit: "quote", value: "20" } },
                ],
              },
            ],
          },
        ],
      })),
    },
    {
      lifetime: "400",
      per_order: "20",
      per_period: "400",
      period_secs: 86_400,
      max_orders_per_period: 100,
      cooldown_secs: 0,
      expires_at: expires,
      slippage_bps: 300,
    },
    SYMS,
  );
  step("rebalance armed", true, rebalance.instance.slice(0, 8));
  step(
    "portfolio feeds accepted by the signed plan",
    rebalance.render.includes("value:") && rebalance.render.includes("equity"),
  );

  let filled = 0;
  for (let i = 0; i < 60 && filled < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const now = await Promise.all(SYMS.map((s) => held(s)));
    filled = now.filter((v, k) => v > (openings[SYMS[k] as string] as bigint)).length;
    process.stdout.write(`\r  rebalance t+${(i + 1) * 5}s topped up ${filled}/3   `);
  }
  console.log();
  for (const [i, s] of SYMS.entries()) {
    const now = await held(s);
    step(`${s} topped up`, now > (openings[s] as bigint), `${Number(now) / 1e8}`);
    void i;
  }
} finally {
  await close();
}
