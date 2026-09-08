import type { Asset } from "../validation/index.js";
import {
  CLARIFY_TOOL,
  type Compiler,
  clarifyJsonSchema,
  PROPOSE_TOOL,
  type Proposal,
  proposalJsonSchema,
  systemPrompt,
  toProposal,
} from "./shared.js";

/**
 * Google Gemini, via `generateContent` function calling.
 *
 * Gemini does not speak the OpenAI shape, so it needs its own adapter: instructions go in
 * `systemInstruction` rather than a system message, tools are `functionDeclarations`, and the
 * answer arrives as a `functionCall` part with `args` already parsed rather than as a JSON
 * string. Everything after that is the shared validation.
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

type Part = { functionCall?: { name?: string; args?: unknown } };
type Response = {
  candidates?: { content?: { parts?: Part[] } }[];
  error?: { message?: string };
};

/**
 * Gemini's schema dialect is OpenAPI 3, not JSON Schema, and it rejects several keywords zod
 * emits. Dropping them is safe here because the schema is a hint to the model, not the
 * validation: `toProposal` re-checks whatever comes back against the real zod schema.
 */
const UNSUPPORTED = new Set([
  "$schema",
  "additionalProperties",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "const",
  "definitions",
  "$defs",
  "$ref",
  "patternProperties",
  "not",
]);

function toOpenApi(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toOpenApi);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (UNSUPPORTED.has(key)) continue;
    out[key] = toOpenApi(inner);
  }
  return out;
}

export class GoogleCompiler implements Compiler {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly key: string,
    private readonly model: string,
    options: { baseUrl?: string | undefined; fetcher?: typeof fetch } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  async compile(prompt: string, assets: Asset[]): Promise<Proposal> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let response: globalThis.Response;
    try {
      response = await this.fetcher(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          // The key travels as a header rather than a query parameter so it cannot end up in an
          // access log or a proxy's URL history.
          headers: { "content-type": "application/json", "x-goog-api-key": this.key },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt(assets) }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: PROPOSE_TOOL,
                    description: "Propose the strategy for human review",
                    parameters: toOpenApi(proposalJsonSchema()),
                  },
                  {
                    name: CLARIFY_TOOL,
                    description: "Explain missing details or unsupported requests",
                    parameters: toOpenApi(clarifyJsonSchema),
                  },
                ],
              },
            ],
            // Gemini's equivalent of "you must call a tool".
            toolConfig: { functionCallingConfig: { mode: "ANY" } },
          }),
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => null)) as Response | null;
    if (!response.ok)
      throw new Error(body?.error?.message ?? `Compiler request failed (${response.status})`);
    const call = body?.candidates?.[0]?.content?.parts?.find(
      (part) => part.functionCall,
    )?.functionCall;
    if (!call?.name) throw new Error("The compiler did not return a strategy");
    return toProposal(call.name, call.args, assets);
  }
}
