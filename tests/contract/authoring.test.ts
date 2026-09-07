import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Asset } from "../../packages/contracts/src/index.js";
import type { Plan, Proposal } from "../../packages/strategy/src/index.js";
import { ClarificationRequired } from "../../packages/strategy/src/index.js";
import {
  type ContractApi,
  call,
  newIdentity,
  startContractApi,
  type TestIdentity,
} from "./harness.js";

/**
 * Authoring a strategy in plain English, through the real HTTP surface.
 *
 * The compiler is stubbed, and deliberately: what these tests pin is the CONTRACT around it —
 * that a prompt reaches it with the catalogue, that what comes back is validated rather than
 * trusted, that a request for clarification is a different answer from a failure, and that an
 * unconfigured deployment says so instead of erroring obscurely. None of that is about
 * Anthropic, and testing it against the real API would make the suite depend on a key, a
 * network and a model's mood.
 *
 * The one thing a stub cannot check is whether the model produces good plans. That is what the
 * `validatePlan` call in the route is for: whatever the model returns is checked against the
 * same schema a hand-written plan is, so a bad proposal is refused by the API rather than
 * stored and signed.
 */

let api: ContractApi;
let alice: TestIdentity;

/** Records what it was asked, and answers with whatever the test set. */
class StubCompiler {
  prompts: string[] = [];
  assetsSeen: Asset[][] = [];
  constructor(private readonly answer: () => Proposal) {}
  async compile(prompt: string, assets: Asset[]): Promise<Proposal> {
    this.prompts.push(prompt);
    this.assetsSeen.push(assets);
    return this.answer();
  }
}

/** A plan the validator accepts: buy AAPLc when its oracle price falls below 200. */
const goodPlan = (): Plan =>
  ({
    params: [],
    nodes: [
      {
        id: "cheap",
        op: "lt",
        args: [
          { kind: "feed", feed: "oracle:AAPLc" },
          { kind: "const", value: "200" },
        ],
      },
    ],
    machines: [
      {
        id: "buy",
        scope: "portfolio",
        initial: "watch",
        states: [
          {
            id: "watch",
            transitions: [
              {
                when: "cheap",
                fires: "on_edge",
                to: "watch",
                actions: [
                  { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "50" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }) as unknown as Plan;

const draftBody = {
  prompt: "Buy $50 of Apple whenever it trades under $200.",
  assets: ["AAPLc"],
  mode: "manual",
  caps: {
    lifetime: "500",
    per_order: "50",
    per_period: "100",
    period_secs: 86_400,
    max_orders_per_period: 2,
    cooldown_secs: 0,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    slippage_bps: 50,
  },
};

afterAll(async () => {
  await api?.close();
});

beforeAll(() => {
  alice = newIdentity();
});

test("a prompt becomes a reviewable draft, and the model never sees more than the catalogue", async () => {
  const compiler = new StubCompiler(() => ({
    name: "Apple under 200",
    reading: "Buy $50 of Apple when its reference price falls below $200.",
    plan: goodPlan(),
  }));
  api = await startContractApi({ identities: [alice], compiler });

  const response = await call(api, {
    method: "POST",
    url: "/v1/strategies/draft",
    token: alice.token,
    wallet: alice.wallet,
    payload: draftBody,
  });
  // 201: a draft is created, not fetched.
  expect(response.statusCode).toBe(201);

  const body = response.json<{
    render_text: string;
    confirm_message: string;
    artifact_id: string;
  }>();
  // The rendered card is what the user signs, so it must actually describe the strategy rather
  // than echo the prompt back at them.
  expect(body.render_text).toContain("AAPLc");
  expect(body.confirm_message).toContain("Mandate strategy authorization");
  expect(body.artifact_id).toMatch(/^[0-9a-f]{64}$/);

  // The prompt reached the compiler verbatim, with the catalogue it is allowed to choose from.
  expect(compiler.prompts).toEqual([draftBody.prompt]);
  const seen = compiler.assetsSeen[0] ?? [];
  expect(seen.map((asset) => asset.symbol)).toEqual(["AAPLc"]);
});

test("a plan the model invents is validated, not trusted", async () => {
  // `oracle:DOGE` is not in the catalogue. A model that hallucinates a feed must not be able to
  // put it in front of a user for signature — the route validates the proposal against the same
  // schema a hand-written plan passes through.
  const rogue = goodPlan() as unknown as {
    nodes: { args: { kind: string; feed?: string }[] }[];
  };
  const arg = rogue.nodes[0]?.args[0];
  if (arg) arg.feed = "oracle:DOGE";

  const compiler = new StubCompiler(() => ({
    name: "Rogue",
    reading: "Buy something that is not listed.",
    plan: rogue as unknown as Plan,
  }));
  const rogueApi = await startContractApi({ identities: [alice], compiler });
  try {
    const response = await call(rogueApi, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  } finally {
    await rogueApi.close();
  }
});

test("a request for missing detail is a question, not a failure", async () => {
  const compiler = {
    async compile(): Promise<Proposal> {
      throw new ClarificationRequired("Which price should trigger the buy, and how much per buy?");
    },
  };
  const asking = await startContractApi({ identities: [alice], compiler });
  try {
    const response = await call(asking, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: { ...draftBody, prompt: "Buy Apple sometimes." },
    });
    // 422 and a distinct code, so the client can render it beside the prompt as something to
    // answer rather than in the red banner reserved for things that broke.
    expect(response.statusCode).toBe(422);
    const problem = response.json<{ code: string; detail: string }>();
    expect(problem.code).toBe("clarification-required");
    expect(problem.detail).toContain("Which price");
  } finally {
    await asking.close();
  }
});

test("without a key, text authoring says so and the structured builder still works", async () => {
  const bare = await startContractApi({ identities: [alice] });
  try {
    const refused = await call(bare, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody,
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.json<{ detail: string }>().detail).toContain("compiler");

    // The same endpoint, same deployment, with a plan instead of a prompt. Text authoring being
    // off must not take authoring off.
    const structured = await call(bare, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: { ...draftBody, prompt: undefined, plan: goodPlan(), name: "Apple under 200" },
    });
    expect(structured.statusCode).toBe(201);
  } finally {
    await bare.close();
  }
});
