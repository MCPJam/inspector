import type { EvalTraceSpan } from "@/shared/eval-trace";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  pushAiSdkTrailingErrorSpan,
  pushBackendStepLlmFailureSpans,
  pushBackendStepSuccessSpans,
  pushBackendStepToolFailureSpans,
  registerAiSdkPrepareStep,
  wrapBackendToolsForTrace,
  wrapToolSetForEvalTrace,
} from "../eval-trace-capture";

describe("eval-trace-capture", () => {
  const runAt = 10_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("backend success: one step, LLM only — parent wraps LLM child", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepSuccessSpans(spans, runAt, 0, runAt + 0, {
      startAbs: runAt + 0,
      endAbs: runAt + 50,
    });
    const parent = spans.find((s) => s.id === "eval-backend-step-0");
    const llm = spans.find((s) => s.id === "eval-backend-step-0-llm");
    expect(parent?.category).toBe("step");
    expect(llm?.parentId).toBe(parent?.id);
    expect(parent!.startMs).toBeLessThan(parent!.endMs);
    expect(llm!.startMs).toBeGreaterThanOrEqual(parent!.startMs);
    expect(llm!.endMs).toBeLessThanOrEqual(parent!.endMs);
  });

  it("backend success: LLM span name includes modelId when meta provides it", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepSuccessSpans(
      spans,
      runAt,
      0,
      runAt + 0,
      { startAbs: runAt + 0, endAbs: runAt + 50 },
      undefined,
      { modelId: "claude-3-opus" },
    );
    const llm = spans.find((s) => s.id === "eval-backend-step-0-llm");
    expect(llm?.name).toBe("claude-3-opus · response");
  });

  it("backend success: LLM + tools — children within parent", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepSuccessSpans(
      spans,
      runAt,
      0,
      runAt,
      { startAbs: runAt, endAbs: runAt + 20 },
      { startAbs: runAt + 20, endAbs: runAt + 40 },
    );
    const parent = spans.find((s) => s.id === "eval-backend-step-0");
    const tools = spans.find((s) => s.id === "eval-backend-step-0-tools");
    expect(tools?.endMs).toBeLessThanOrEqual(parent!.endMs);
  });

  it("backend LLM failure — error child under step", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepLlmFailureSpans(spans, runAt, 0, runAt, runAt, runAt + 5);
    expect(spans.some((s) => s.category === "error")).toBe(true);
  });

  it("backend tool failure — LLM sibling then error", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepToolFailureSpans(
      spans,
      runAt,
      0,
      runAt,
      { startAbs: runAt, endAbs: runAt + 10 },
      runAt + 10,
      runAt + 15,
    );
    expect(spans.filter((s) => s.category === "error")).toHaveLength(1);
  });

  it("AI SDK: one step, no tools — step + LLM only", () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0, { modelId: "gpt-4o" });
    emitAiSdkOnStepFinish(ctx, runAt + 40, {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      messageStartIndex: 1,
      messageEndIndex: 2,
      status: "ok",
    });
    const step = ctx.recordedSpans.find((s) => s.id === "step-0");
    const llm = ctx.recordedSpans.find((s) => s.id === "step-0-llm");
    expect(step?.category).toBe("step");
    expect(llm?.category).toBe("llm");
    expect(llm?.name).toBe("gpt-4o · response");
    expect(llm?.parentId).toBe("step-0");
    expect(ctx.recordedSpans.filter((s) => s.category === "tool")).toHaveLength(
      0,
    );
    expect(step!.endMs).toBeGreaterThan(step!.startMs);
    expect(llm!.endMs).toBeGreaterThan(llm!.startMs);
    expect(step).toEqual(
      expect.objectContaining({
        promptIndex: 0,
        stepIndex: 0,
        modelId: "gpt-4o",
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        messageStartIndex: 1,
        messageEndIndex: 2,
        status: "ok",
      }),
    );
    expect(llm).toEqual(
      expect.objectContaining({
        promptIndex: 0,
        stepIndex: 0,
        modelId: "gpt-4o",
        messageStartIndex: 1,
        messageEndIndex: 2,
      }),
    );
  });

  it("AI SDK: one step + tool — LLM ends at first tool start", async () => {
    let wall = runAt;
    vi.spyOn(Date, "now").mockImplementation(() => wall);

    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);

    wall = runAt + 30;
    const tools = wrapToolSetForEvalTrace(
      {
        search: {
          description: "x",
          inputSchema: {},
          execute: async () => "ok",
        },
      },
      ctx,
    );

    wall = runAt + 50;
    await tools.search.execute({}, { toolCallId: "tc1", messages: [] });

    wall = runAt + 120;
    emitAiSdkOnStepFinish(ctx, wall);

    const llm = ctx.recordedSpans.find((s) => s.id === "step-0-llm");
    const tool = ctx.recordedSpans.find((s) => s.id === "tool-tc1");
    expect(llm!.endMs - llm!.startMs).toBe(50);
    expect(tool?.name).toBe("search");
    expect(tool?.parentId).toBe("step-0");
  });

  it("AI SDK: failed tool execute — tool + tool error spans", async () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    const tools = wrapToolSetForEvalTrace(
      {
        boom: {
          execute: async () => {
            throw new Error("fail");
          },
        },
      },
      ctx,
    );
    await expect(
      tools.boom.execute({}, { toolCallId: "tcfail", messages: [] }),
    ).rejects.toThrow("fail");

    const tool = ctx.recordedSpans.find((s) => s.id === "tool-tcfail");
    const err = ctx.recordedSpans.find((s) => s.id === "tool-err-tcfail");
    expect(tool?.category).toBe("tool");
    expect(err?.category).toBe("error");
    expect(err?.name).toBe("boom error");
    expect(tool).toEqual(
      expect.objectContaining({
        toolCallId: "tcfail",
        toolName: "boom",
        stepIndex: 0,
        status: "error",
      }),
    );
  });

  it("AI SDK: failure before any step — generation error only", () => {
    const ctx = createAiSdkEvalTraceContext(runAt);
    finalizeAiSdkTraceOnFailure(ctx, runAt + 5, {
      completedStepCount: 0,
      lastStepEndedAt: runAt,
    });
    expect(ctx.recordedSpans).toHaveLength(1);
    expect(ctx.recordedSpans[0]!.name).toBe("Generation error");
    expect(ctx.recordedSpans[0]!.startMs).toBe(0);
  });

  it("AI SDK: failure after completed steps — trailing generation error", () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    emitAiSdkOnStepFinish(ctx, runAt + 20);
    finalizeAiSdkTraceOnFailure(ctx, runAt + 25, {
      completedStepCount: 1,
      lastStepEndedAt: runAt + 20,
    });
    const genErr = ctx.recordedSpans.find((s) => s.name === "Generation error");
    expect(genErr?.startMs).toBe(20);
    expect(genErr?.endMs).toBe(25);
  });

  it("patchAiSdkRecordedSpansMessageRangesFromSteps fills indices when onStepFinish omitted them", () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0, { modelId: "gpt-4o" });
    emitAiSdkOnStepFinish(ctx, runAt + 40, {
      modelId: "gpt-4o",
      status: "ok",
    });
    const baseLen = 2;
    patchAiSdkRecordedSpansMessageRangesFromSteps(ctx.recordedSpans, baseLen, [
      {
        response: {
          messages: [{ role: "assistant", content: "hello" }],
        },
      },
    ]);
    const llm = ctx.recordedSpans.find((s) => s.id === "step-0-llm");
    const step = ctx.recordedSpans.find((s) => s.id === "step-0");
    expect(llm?.messageStartIndex).toBe(2);
    expect(llm?.messageEndIndex).toBe(2);
    expect(step?.messageStartIndex).toBe(2);
    expect(step?.messageEndIndex).toBe(2);
  });

  it("patchAiSdkRecordedSpansMessageRangesFromSteps does not overwrite existing message indices", () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    emitAiSdkOnStepFinish(ctx, runAt + 40, {
      messageStartIndex: 5,
      messageEndIndex: 6,
      status: "ok",
    });
    patchAiSdkRecordedSpansMessageRangesFromSteps(ctx.recordedSpans, 0, [
      {
        response: {
          messages: [{ role: "assistant", content: "other" }],
        },
      },
    ]);
    const llm = ctx.recordedSpans.find((s) => s.id === "step-0-llm");
    expect(llm?.messageStartIndex).toBe(5);
    expect(llm?.messageEndIndex).toBe(6);
  });

  it("patchAiSdkRecordedSpansMessageRangesFromSteps applies step range to tool children missing indices", async () => {
    let wall = runAt;
    vi.spyOn(Date, "now").mockImplementation(() => wall);

    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    wall = runAt + 30;
    const tools = wrapToolSetForEvalTrace(
      {
        search: {
          description: "x",
          inputSchema: {},
          execute: async () => "ok",
        },
      },
      ctx,
    );
    wall = runAt + 50;
    await tools.search.execute({}, { toolCallId: "tc-patch", messages: [] });
    wall = runAt + 120;
    emitAiSdkOnStepFinish(ctx, wall, { status: "ok" });

    const toolBefore = ctx.recordedSpans.find((s) => s.id === "tool-tc-patch");
    expect(toolBefore?.messageStartIndex).toBeUndefined();

    patchAiSdkRecordedSpansMessageRangesFromSteps(ctx.recordedSpans, 1, [
      {
        response: {
          messages: [
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
          ],
        },
      },
    ]);
    const toolAfter = ctx.recordedSpans.find((s) => s.id === "tool-tc-patch");
    expect(toolAfter?.messageStartIndex).toBe(1);
    expect(toolAfter?.messageEndIndex).toBe(1);
  });

  it("AI SDK: two steps — separate step ids and stable numbering", () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    emitAiSdkOnStepFinish(ctx, runAt + 10);
    registerAiSdkPrepareStep(ctx, 1);
    emitAiSdkOnStepFinish(ctx, runAt + 25);
    const steps = ctx.recordedSpans.filter((s) => s.category === "step");
    expect(steps.map((s) => s.id)).toEqual(["step-0", "step-1"]);
    expect(steps.map((s) => s.name)).toEqual(["Step 1", "Step 2"]);
  });

  it("AI SDK: same-ms timing normalization — endMs > startMs", () => {
    const spans: EvalTraceSpan[] = [];
    pushAiSdkTrailingErrorSpan(spans, runAt, runAt + 10, runAt + 10);
    expect(spans[0]!.endMs).toBeGreaterThan(spans[0]!.startMs);
  });

  it("backend wrapped tools emit per-call spans with tool metadata", async () => {
    let wall = runAt;
    vi.spyOn(Date, "now").mockImplementation(() => wall);

    const spans: EvalTraceSpan[] = [];
    const backendTools = wrapBackendToolsForTrace(
      {
        search: {
          execute: async () => ({ ok: true }),
          _serverId: "server-1",
        },
      },
      {
        runStartedAt: runAt,
        stepIndex: 2,
        spans,
      },
    );

    wall = runAt + 15;
    await backendTools.search.execute(
      { q: "weather" },
      { toolCallId: "call-99" },
    );

    expect(spans).toEqual([
      expect.objectContaining({
        category: "tool",
        promptIndex: 0,
        stepIndex: 2,
        toolCallId: "call-99",
        toolName: "search",
        serverId: "server-1",
        status: "ok",
      }),
    ]);
  });
});
