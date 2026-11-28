import type { ModelMessage } from "ai";
import {
  appendDedupedModelMessages,
  createEvalSpanIntegration,
  createEvalSpanSink,
  patchEvalSpansMessageRangesFromSteps,
  runnerCallCost,
} from "../src/eval-trace-spans";

describe("appendDedupedModelMessages", () => {
  it("skips duplicate messages by json key", () => {
    const acc: ModelMessage[] = [];
    const m: ModelMessage = { role: "assistant", content: "a" };
    appendDedupedModelMessages(acc, [m]);
    appendDedupedModelMessages(acc, [m]);
    expect(acc).toHaveLength(1);
  });
});

describe("patchEvalSpansMessageRangesFromSteps", () => {
  it("fills indices on step/llm/tool spans when onStepFinish had empty step messages", () => {
    const rel = () => 0;
    const sink = createEvalSpanSink(rel);
    sink.onStepStart(0, 0);
    sink.onToolStart("tc-1", "my_tool", 0, 0);
    sink.onToolEnd("tc-1");
    sink.onStepFinish(0, 5, {
      modelId: "gpt-4o",
      status: "ok",
    });

    const spans = sink.getSpans();
    const step = spans.find((s) => s.category === "step");
    const tool = spans.find((s) => s.category === "tool");
    expect(step?.messageStartIndex).toBeUndefined();

    patchEvalSpansMessageRangesFromSteps(spans, 1, [
      {
        response: {
          messages: [
            { role: "assistant", content: "thinking" },
            { role: "assistant", content: "done" },
          ] as ModelMessage[],
        },
      },
    ]);

    expect(step?.messageStartIndex).toBe(1);
    expect(step?.messageEndIndex).toBe(2);
    expect(tool?.messageStartIndex).toBe(1);
    expect(tool?.messageEndIndex).toBe(2);
  });

  it("does not overwrite spans that already have indices", () => {
    const rel = () => 0;
    const sink = createEvalSpanSink(rel);
    sink.onStepStart(0, 0);
    sink.onStepFinish(0, 10, {
      messageStartIndex: 9,
      messageEndIndex: 10,
      status: "ok",
    });
    const spans = sink.getSpans();
    const step = spans.find((s) => s.category === "step");
    patchEvalSpansMessageRangesFromSteps(spans, 1, [
      {
        response: {
          messages: [{ role: "assistant", content: "x" }],
        },
      },
    ]);
    expect(step?.messageStartIndex).toBe(9);
    expect(step?.messageEndIndex).toBe(10);
  });
});

describe("runner call cost on eval spans", () => {
  const stepEnd = (providerMetadata?: unknown) =>
    ({
      stepNumber: 0,
      usage: {
        inputTokens: 120,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 20 },
        outputTokens: 30,
        outputTokenDetails: { textTokens: 30 },
        totalTokens: 150,
      },
      providerMetadata,
      finishReason: "stop",
      response: { modelId: "gpt-4o", id: "resp-1" },
    }) as never;

  function recordOneStep(providerMetadata?: unknown) {
    const integration = createEvalSpanIntegration({ rel: () => 0 });
    integration.onStepStart?.({ stepNumber: 0, modelId: "gpt-4o" } as never);
    integration.onStepEnd?.(stepEnd(providerMetadata));
    return integration.getSpans();
  }

  it("keeps reported dollars on the llm span only, as runner-reported and customer-funded", () => {
    const spans = recordOneStep({ openrouter: { usage: { cost: 0.004 } } });

    expect(spans.filter((span) => span.cost)).toEqual([
      expect.objectContaining({
        category: "llm",
        cost: expect.objectContaining({
          completeness: "complete",
          amountUsd: 0.004,
          source: "runner_reported",
          reporter: "openrouter",
          funding: "customer",
          usageSource: "runner",
          usage: {
            uncachedInputTokens: 100,
            cacheReadTokens: 20,
            outputTokens: 30,
          },
        }),
      }),
    ]);
  });

  it("records an unpriced call as unavailable rather than guessing a rate", () => {
    const llm = recordOneStep().find((span) => span.category === "llm");

    expect(llm?.cost).toMatchObject({
      completeness: "unavailable",
      reason: "no_rate",
      usageSource: "runner",
    });
    expect(llm?.cost?.amountUsd).toBeUndefined();
  });

  it("never records the runner's dollars as provider-reported", () => {
    expect(
      runnerCallCost(undefined, { gateway: { cost: 0.02 } })
    ).toMatchObject({
      completeness: "complete",
      amountUsd: 0.02,
      source: "runner_reported",
      reporter: "gateway",
    });
  });

  it("says no usage when the step reported none", () => {
    expect(runnerCallCost(undefined, undefined)).toMatchObject({
      completeness: "unavailable",
      reason: "no_usage",
    });
  });
});
