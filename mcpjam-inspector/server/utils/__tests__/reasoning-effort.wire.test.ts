import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, it } from "vitest";
import {
  reasoningEffortProviderOptions,
  supportedReasoningEfforts,
} from "@mcpjam/sdk/browser";

/**
 * The providerOptions the effort module emits must reach the wire in the
 * INSTALLED provider package (inspector: `@ai-sdk/*@^3`; the inspector and backend
 * pin their own majors and carry their own copy of this test). A provider
 * that strips an option it does not know would turn "applied" into "dropped".
 *
 * OpenAI `max` is backend/Gateway only: the direct table never emits it.
 */
async function captureBody(
  make: (
    fetch: typeof globalThis.fetch,
  ) => Parameters<typeof generateText>[0]["model"],
  providerOptions: Record<string, Record<string, unknown>>,
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
    prompt: "hi",
    providerOptions: providerOptions as any,
  }).catch((error) => {
    if (body === undefined) throw error;
  });
  if (body === undefined) throw new Error("provider sent no request");
  return body;
}

describe("reasoning effort on the wire (installed @ai-sdk providers)", () => {
  it("openai sends reasoning_effort", async () => {
    const options = reasoningEffortProviderOptions({
      providerKey: "openai",
      modelId: "gpt-5",
      effort: "high",
    })!;
    const body = await captureBody(
      (fetch) => createOpenAI({ apiKey: "k", fetch }).chat("gpt-5"),
      options,
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
    expect(body.reasoning_effort).toBe("high");
  });

  it("anthropic sends output_config.effort with adaptive thinking", async () => {
    const options = reasoningEffortProviderOptions({
      providerKey: "anthropic",
      modelId: "claude-sonnet-4-6",
      effort: "low",
    })!;
    const body = await captureBody(
      (fetch) => createAnthropic({ apiKey: "k", fetch })("claude-sonnet-4-6"),
      options,
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
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("google sends thinkingConfig.thinkingLevel", async () => {
    const options = reasoningEffortProviderOptions({
      providerKey: "google",
      modelId: "gemini-3-pro",
      effort: "low",
    })!;
    const body = await captureBody(
      (fetch) =>
        createGoogleGenerativeAI({ apiKey: "k", fetch })("gemini-3-pro"),
      options,
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    );
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  });

  it.each([
    ["openai", "gpt-5"],
    ["openai", "gpt-5.1"],
    ["openai", "gpt-5.2"],
    ["openai", "o3"],
    ["anthropic", "claude-sonnet-4-6"],
    ["google", "gemini-3-pro"],
    ["google", "gemini-3-flash"],
  ] as const)(
    "%s %s: every level the table offers survives the provider's option schema",
    async (providerKey, modelId) => {
      const levels = supportedReasoningEfforts({
        route: "direct",
        providerKey,
        modelId,
      });
      expect(levels.length).toBeGreaterThan(0);
      for (const effort of levels) {
        const options = reasoningEffortProviderOptions({
          providerKey,
          modelId,
          effort,
        })!;
        const body =
          providerKey === "openai"
            ? await captureBody(
                (fetch) => createOpenAI({ apiKey: "k", fetch }).chat(modelId),
                options,
                {},
              )
            : providerKey === "anthropic"
              ? await captureBody(
                  (fetch) => createAnthropic({ apiKey: "k", fetch })(modelId),
                  options,
                  {},
                )
              : await captureBody(
                  (fetch) =>
                    createGoogleGenerativeAI({ apiKey: "k", fetch })(modelId),
                  options,
                  {},
                );
        const sent =
          body.reasoning_effort ??
          body.output_config?.effort ??
          body.generationConfig?.thinkingConfig?.thinkingLevel;
        expect(sent, `${providerKey} ${effort}`).toBe(effort);
      }
    },
  );
});
