import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { withUniqueToolCallIds } from "../src/tool-call-ids";

describe("provider call identity", () => {
  it("keeps a late provider result attached to its earlier call", async () => {
    const call = {
      type: "tool-call" as const,
      toolName: "fixture",
      toolCallId: "previous_call",
      input: "{}",
    };
    const lateResult = {
      type: "tool-result" as const,
      toolName: "fixture",
      toolCallId: "previous_call",
      result: "completed",
    };
    const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
    const finishReason = { unified: "stop" as const, raw: undefined };
    const model = withUniqueToolCallIds(new MockLanguageModelV4({
      doGenerate: async () => ({ content: [lateResult], usage, finishReason, warnings: [] }),
      doStream: async () => ({
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([lateResult]),
      }),
    }), [{ role: "assistant", content: [{ ...call, input: {} }] }]);
    expect((await model.doGenerate({ prompt: [] })).content).toEqual([lateResult]);
    const reader = (await model.doStream({ prompt: [] })).stream.getReader();
    expect((await reader.read()).value).toEqual(lateResult);
  });
});
