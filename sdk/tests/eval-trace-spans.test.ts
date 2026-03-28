import type { ModelMessage } from "ai";
import {
  appendDedupedModelMessages,
  createEvalSpanSink,
  patchEvalSpansMessageRangesFromSteps,
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
