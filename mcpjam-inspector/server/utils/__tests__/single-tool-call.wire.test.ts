import { generateText, jsonSchema, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, it } from "vitest";
import { singleToolCallProviderOptions } from "@mcpjam/sdk";
import { reasoningEffortProviderOptions } from "@mcpjam/sdk/browser";

/**
 * The direct chat path turns off parallel tool calls through a step's
 * `prepareStep` providerOptions, on top of the call's own (reasoning effort).
 * Both must reach the wire in the INSTALLED provider packages.
 */
async function captureBody(
  make: (
    fetch: typeof globalThis.fetch,
  ) => Parameters<typeof generateText>[0]["model"],
  providerKey: string,
  callProviderOptions: Record<string, Record<string, unknown>>,
  response: unknown,
): Promise<Record<string, any>> {
  let body: Record<string, any> | undefined;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  await generateText({
    model: make(fetch),
    prompt: "show me barca",
    tools: {
      load_mcp_tools: tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
      }),
    },
    providerOptions: callProviderOptions as any,
    prepareStep: () => ({
      providerOptions: singleToolCallProviderOptions(providerKey),
    }),
  }).catch((error) => {
    if (body === undefined) throw error;
  });
  if (body === undefined) throw new Error("provider sent no request");
  return body;
}

describe("one tool call per step on the wire (installed @ai-sdk providers)", () => {
  it("anthropic sends disable_parallel_tool_use and keeps the effort", async () => {
    const body = await captureBody(
      (fetch) => createAnthropic({ apiKey: "k", fetch })("claude-sonnet-4-6"),
      "anthropic",
      reasoningEffortProviderOptions({
        providerKey: "anthropic",
        modelId: "claude-sonnet-4-6",
        effort: "low",
      })!,
      {
        id: "x",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    );
    expect(body.tool_choice).toMatchObject({ disable_parallel_tool_use: true });
    expect(body.output_config).toMatchObject({ effort: "low" });
  });

  it("openai sends parallel_tool_calls: false", async () => {
    const body = await captureBody(
      (fetch) => createOpenAI({ apiKey: "k", fetch }).chat("gpt-5"),
      "openai",
      {},
      {
        id: "x",
        created: 1,
        model: "gpt-5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    );
    expect(body.parallel_tool_calls).toBe(false);
  });
});
