import type { Asset } from "../validation/index.js";
import {
  CLARIFY_TOOL,
  type Compiler,
  clarifyJsonSchema,
  PROPOSE_TOOL,
  type Proposal,
  parseArguments,
  proposalJsonSchema,
  systemPrompt,
  toProposal,
} from "./shared.js";

/**
 * Any OpenAI-compatible chat-completions endpoint.
 *
 * One adapter, many providers. `/v1/chat/completions` with `tools` is the most widely cloned
 * shape in the industry: OpenAI, Groq, Together, OpenRouter, DeepSeek, xAI, Fireworks and a
 * local Ollama or llama.cpp all speak it. Pointing `baseUrl` at any of them is the whole of the
 * integration, which is why this is worth more than an OpenAI-specific client would be.
 *
 * Written against `fetch` rather than the `openai` package deliberately. The request is one JSON
 * body with a tools array; a dependency to construct it buys nothing, and the SDK's own base-URL
 * handling is the part most likely to disagree with a third-party host.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type ToolCall = { function?: { name?: string; arguments?: string } };
type Completion = {
  choices?: { message?: { tool_calls?: ToolCall[] } }[];
  error?: { message?: string };
};

export class OpenAICompiler implements Compiler {
  private readonly baseUrl: string;
  constructor(
    private readonly key: string,
    private readonly model: string,
    options: { baseUrl?: string | undefined; fetcher?: typeof fetch } = {},
  ) {
    // Trailing slashes are the classic way a self-hosted base URL turns into a 404.
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }
  private readonly fetcher: typeof fetch;

  async compile(prompt: string, assets: Asset[]): Promise<Proposal> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.key}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          // `required` is this API's equivalent of Anthropic's `any`: answer with a tool call,
          // not with prose. Without it a model will happily explain the strategy in English,
          // which is not something the draft endpoint can validate or render.
          tool_choice: "required",
          parallel_tool_calls: false,
          messages: [
            { role: "system", content: systemPrompt(assets) },
            { role: "user", content: prompt },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: PROPOSE_TOOL,
                description: "Propose the strategy for human review",
                parameters: proposalJsonSchema(),
              },
            },
            {
              type: "function",
              function: {
                name: CLARIFY_TOOL,
                description: "Explain missing details or unsupported requests",
                parameters: clarifyJsonSchema,
              },
            },
          ],
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => null)) as Completion | null;
    if (!response.ok) {
      // The provider's message is not shown to the user — the route turns any throw into a
      // generic "try again shortly" — but it is the only thing that makes an operator's log
      // useful when a third-party host rejects a model name or a key.
      throw new Error(body?.error?.message ?? `Compiler request failed (${response.status})`);
    }
    const call = body?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.name) throw new Error("The compiler did not return a strategy");
    return toProposal(call.function.name, parseArguments(call.function.arguments), assets);
  }
}
