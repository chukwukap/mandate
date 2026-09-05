import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { type Asset, type Plan, planSchema, validatePlan } from "../strategy.js";

export type Proposal = { name: string; reading: string; plan: Plan };
export interface Compiler {
  compile(prompt: string, assets: Asset[]): Promise<Proposal>;
}
const proposalSchema = z.strictObject({
  name: z.string().min(1).max(100),
  reading: z.string().min(1).max(2000),
  plan: planSchema,
});

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
    const json = z.toJSONSchema(proposalSchema, { target: "draft-7", io: "input" });
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: `Translate the user's own instructions into a reviewable strategy. Never choose investments or invent prices, amounts or thresholds. Ask for clarification by using explain_missing when essential details are absent or unsupported. Plans use decimal strings and portfolio-scoped machines. Buys use quote or pct_equity sizes; sells use base or pct_position sizes. Never invent feed URIs. Conditions default to on_edge. while_true needs a finite max_repeats. A halt ends execution. There are no calendar, time-series, news, or technical-indicator inputs. Available assets by index: ${JSON.stringify(assets.map((a, i) => ({ index: i, symbol: a.symbol })))}. Available feeds: ${assets.flatMap((a) => [`dex:${a.symbol}`, `oracle:${a.symbol}`]).join(", ")}.`,
      tools: [
        {
          name: "propose_strategy",
          description: "Propose the strategy for human review",
          input_schema: { ...json, type: "object" },
        },
        {
          name: "explain_missing",
          description: "Explain missing details or unsupported requests",
          input_schema: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: prompt }],
    });
    const tool = response.content.find((c) => c.type === "tool_use");
    if (tool?.type !== "tool_use") throw new Error("The compiler did not return a strategy");
    if (tool.name === "explain_missing") {
      const reason = z.object({ reason: z.string().max(2000) }).parse(tool.input);
      throw new ClarificationRequired(reason.reason);
    }
    if (tool.name !== "propose_strategy") throw new Error("Unexpected compiler response");
    const proposal = proposalSchema.parse(tool.input);
    return { ...proposal, plan: validatePlan(proposal.plan, assets) };
  }
}
export class ClarificationRequired extends Error {}
