import Anthropic from "@anthropic-ai/sdk";
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
 * The Anthropic adapter.
 *
 * Only the transport lives here. The instructions, the tool schemas and the validation of what
 * comes back are in `shared.ts`, so this file and its OpenAI and Google siblings cannot end up
 * enforcing different rules about what a model is allowed to propose.
 */
export class AnthropicCompiler implements Compiler {
  private readonly client: Anthropic;
  constructor(
    key: string,
    private readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey: key, timeout: 45_000, maxRetries: 1 });
  }

  async compile(prompt: string, assets: Asset[]): Promise<Proposal> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt(assets),
      tools: [
        {
          name: PROPOSE_TOOL,
          description: "Propose the strategy for human review",
          input_schema: proposalJsonSchema() as { type: "object" },
        },
        {
          name: CLARIFY_TOOL,
          description: "Explain missing details or unsupported requests",
          input_schema: clarifyJsonSchema as unknown as { type: "object" },
        },
      ],
      // `any` rather than `auto`: the model must pick one of the two tools. Prose back from a
      // compiler is not an answer this endpoint can do anything with.
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: prompt }],
    });
    const tool = response.content.find((c) => c.type === "tool_use");
    if (tool?.type !== "tool_use") throw new Error("The compiler did not return a strategy");
    return toProposal(tool.name, tool.input, assets);
  }
}

export { ClarificationRequired, type Compiler, type Proposal } from "./shared.js";
