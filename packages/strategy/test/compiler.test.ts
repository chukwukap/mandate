import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicCompiler, ClarificationRequired } from "../src/index.js";

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
function compiler(name: string, input: unknown, status = 200) {
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        system: string;
        tool_choice: { disable_parallel_tool_use: boolean };
      };
      expect(request.model).toBe("test-model");
      expect(request.system).toContain("oracle:AAPLc");
      expect(request.tool_choice.disable_parallel_tool_use).toBe(true);
      return new Response(
        JSON.stringify(
          status === 200
            ? {
                id: "msg_test",
                type: "message",
                role: "assistant",
                model: "test-model",
                content: [{ type: "tool_use", id: "tool_test", name, input }],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 10 },
              }
            : { type: "error", error: { type: "overloaded_error", message: "Unavailable" } },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    },
  });
  return new AnthropicCompiler("test-key", "test-model", client);
}
test("real SDK adapter validates a tool-generated proposal", async () => {
  const result = await compiler("propose_strategy", {
    name: "Alert",
    reading: "Alert above 200",
    plan,
  }).compile("Alert me above 200", [asset]);
  expect(result.plan.params).toEqual([]);
  expect(result.name).toBe("Alert");
});
test("missing instructions return a clarification, not an invented strategy", async () => {
  await expect(
    compiler("explain_missing", { reason: "What threshold should trigger the alert?" }).compile(
      "Alert me",
      [asset],
    ),
  ).rejects.toBeInstanceOf(ClarificationRequired);
});
test("invalid model output and upstream failure are rejected", async () => {
  await expect(
    compiler("propose_strategy", { name: "Invalid", reading: "Invalid", plan: {} }).compile(
      "test",
      [asset],
    ),
  ).rejects.toThrow();
  await expect(compiler("unexpected_tool", {}).compile("test", [asset])).rejects.toThrow(
    "Unexpected compiler response",
  );
  await expect(compiler("propose_strategy", {}, 503).compile("test", [asset])).rejects.toThrow();
});
