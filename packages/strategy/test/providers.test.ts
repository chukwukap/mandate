import { expect, test } from "bun:test";
import {
  ClarificationRequired,
  createCompiler,
  DEFAULT_MODELS,
  GoogleCompiler,
  OpenAICompiler,
} from "../src/index.js";

/**
 * The non-Anthropic adapters, and the rule that picks between them.
 *
 * Each provider is a different wire format for the same conversation, so what these pin is that
 * the format is right and — more importantly — that the guardrails are identical across all of
 * them. A second provider that skipped `validatePlan` would be a way to get an unvalidated plan
 * in front of a user for signature, which is the whole thing the compiler exists to prevent.
 *
 * The transport is a stub `fetch`. Nothing here reaches a network.
 */

const plan = {
  nodes: [
    {
      id: "above",
      op: "gt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "200" },
      ],
    },
  ],
  machines: [
    {
      id: "m",
      scope: "portfolio",
      initial: "watch",
      states: [
        {
          id: "watch",
          transitions: [
            {
              when: "above",
              to: "watch",
              actions: [{ action: "notify", message: "Above threshold" }],
            },
          ],
        },
      ],
    },
  ],
};

const asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}` as `0x${string}`,
  feed: `0x${"22".repeat(20)}` as `0x${string}`,
  decimals: 8,
};

/** Captures the request and answers with a canned body. */
function stub(body: unknown, status = 200) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const openaiCall = (name: string, args: unknown) => ({
  choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
});
const googleCall = (name: string, args: unknown) => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
});

test("the OpenAI adapter sends a tool-required request and validates what comes back", async () => {
  const { fetcher, seen } = stub(
    openaiCall("propose_strategy", { name: "Alert", reading: "Above 200", plan }),
  );
  const result = await new OpenAICompiler("k", "gpt-5", { fetcher }).compile("Alert me above 200", [
    asset,
  ]);
  expect(result.name).toBe("Alert");
  expect(result.plan.params).toEqual([]);

  const request = seen[0];
  expect(request?.url).toBe("https://api.openai.com/v1/chat/completions");
  // `required`, not `auto`. Prose back from a compiler is not something the draft route can
  // validate or render, so the model must answer with one of the two tools.
  expect(request?.body.tool_choice).toBe("required");
  // The catalogue reaches the model, and nothing beyond it.
  expect(JSON.stringify(request?.body.messages)).toContain("AAPLc");
});

test("any OpenAI-compatible host is a base URL away", async () => {
  // The point of the adapter: Groq, Together, OpenRouter, DeepSeek and a local Ollama all speak
  // this shape, so pointing it elsewhere is the whole integration. The trailing slash is the
  // classic way a self-hosted base URL becomes a 404.
  const { fetcher, seen } = stub(
    openaiCall("propose_strategy", { name: "Alert", reading: "Above 200", plan }),
  );
  await new OpenAICompiler("k", "llama-3.3-70b", {
    fetcher,
    baseUrl: "https://api.groq.com/openai/v1/",
  }).compile("Alert me above 200", [asset]);
  expect(seen[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
});

test("the Google adapter speaks generateContent and keeps the key out of the URL", async () => {
  const { fetcher, seen } = stub(
    googleCall("propose_strategy", { name: "Alert", reading: "Above 200", plan }),
  );
  const result = await new GoogleCompiler("secret-key", "gemini-2.5-pro", { fetcher }).compile(
    "Alert me above 200",
    [asset],
  );
  expect(result.name).toBe("Alert");
  const request = seen[0];
  expect(request?.url).toContain("/models/gemini-2.5-pro:generateContent");
  // A key in the query string ends up in access logs and proxy history; it travels as a header.
  expect(request?.url).not.toContain("secret-key");
  expect(request?.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
});

test("every provider refuses a plan that cites an asset it was not given", async () => {
  // The guardrail that matters, checked on each adapter rather than assumed from one. A model
  // that hallucinates `oracle:DOGE` must not be able to produce a signable strategy through
  // any provider.
  const rogue = structuredClone(plan) as unknown as {
    nodes: { args: { feed?: string }[] }[];
  };
  const arg = rogue.nodes[0]?.args[0];
  if (arg) arg.feed = "oracle:DOGE";
  const proposal = { name: "Rogue", reading: "Not listed", plan: rogue };

  const open = stub(openaiCall("propose_strategy", proposal));
  await expect(
    new OpenAICompiler("k", "gpt-5", { fetcher: open.fetcher }).compile("go", [asset]),
  ).rejects.toThrow();

  const google = stub(googleCall("propose_strategy", proposal));
  await expect(
    new GoogleCompiler("k", "gemini-2.5-pro", { fetcher: google.fetcher }).compile("go", [asset]),
  ).rejects.toThrow();
});

test("every provider turns a request for detail into a clarification", async () => {
  const open = stub(openaiCall("explain_missing", { reason: "Which price?" }));
  await expect(
    new OpenAICompiler("k", "gpt-5", { fetcher: open.fetcher }).compile("Buy Apple", [asset]),
  ).rejects.toBeInstanceOf(ClarificationRequired);

  const google = stub(googleCall("explain_missing", { reason: "Which price?" }));
  await expect(
    new GoogleCompiler("k", "gemini-2.5-pro", { fetcher: google.fetcher }).compile("Buy Apple", [
      asset,
    ]),
  ).rejects.toBeInstanceOf(ClarificationRequired);
});

test("a provider error carries its own message, so an operator can read the log", async () => {
  const { fetcher } = stub({ error: { message: "model `gpt-9` does not exist" } }, 404);
  await expect(
    new OpenAICompiler("k", "gpt-9", { fetcher }).compile("go", [asset]),
  ).rejects.toThrow("gpt-9");
});

test("whichever key is set turns authoring on, and a named provider must have one", () => {
  // No key at all is not an error: the structured builder still works and the draft route
  // reports text authoring as unavailable.
  expect(createCompiler({})).toBeUndefined();

  expect(createCompiler({ openaiKey: "k" })).toBeInstanceOf(OpenAICompiler);
  expect(createCompiler({ googleKey: "k" })).toBeInstanceOf(GoogleCompiler);

  // With several configured, the explicit choice wins over the search order.
  expect(createCompiler({ anthropicKey: "a", googleKey: "g", provider: "google" })).toBeInstanceOf(
    GoogleCompiler,
  );

  // Naming a provider whose key is missing is a misconfiguration. Falling back to a different
  // vendor than the operator asked for would be worse than refusing.
  expect(() => createCompiler({ anthropicKey: "a", provider: "openai" })).toThrow("no key");
});

test("each provider has a default model, so a key is the only thing to supply", () => {
  for (const model of Object.values(DEFAULT_MODELS)) expect(model.length).toBeGreaterThan(0);
  expect(new Set(Object.values(DEFAULT_MODELS)).size).toBe(Object.keys(DEFAULT_MODELS).length);
});
