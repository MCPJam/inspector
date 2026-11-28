import type { EvalTraceSpan } from "@/shared/eval-trace";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  pushAiSdkTrailingErrorSpan,
  pushRunSetupSpans,
  pushBackendStepLlmFailureSpans,
  pushBackendStepSuccessSpans,
  pushBackendStepToolFailureSpans,
  registerAiSdkPrepareStep,
  wrapBackendToolsForTrace,
  wrapToolSetForEvalTrace,
} from "../eval-trace-capture";
import {
  MOCK_CALLS_HEADER,
  currentMockAnswerSink,
  formatMockCalls,
  observeMockAnswered,
} from "../../mock/answer-marks";
import { mockAnswerOf } from "@/shared/mock-answer-span";
import { TOOL_POLICY_BLOCK_MARKER } from "../tool-policy-gate";
import { attachAuthChallenge, parseChallengeHeader } from "@mcpjam/sdk";
import { toolAuthChallengeOf } from "../run-setup-signals";

describe("eval-trace-capture", () => {
  const runAt = 10_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("backend success: one step, LLM only — parent wraps LLM child", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepSuccessSpans(spans, runAt, 0, 0, runAt + 0, {
      startAbs: runAt + 0,
      endAbs: runAt + 50,
    });
    const parent = spans.find((s) => s.id === "eval-backend-prompt-0-step-0");
    const llm = spans.find((s) => s.id === "eval-backend-prompt-0-step-0-llm");
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
      0,
      runAt + 0,
      { startAbs: runAt + 0, endAbs: runAt + 50 },
      undefined,
      { modelId: "claude-3-opus" },
    );
    const llm = spans.find((s) => s.id === "eval-backend-prompt-0-step-0-llm");
    expect(llm?.name).toBe("claude-3-opus · response");
  });

  it("backend success: LLM + tools — children within parent", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepSuccessSpans(
      spans,
      runAt,
      0,
      0,
      runAt,
      { startAbs: runAt, endAbs: runAt + 20 },
      { startAbs: runAt + 20, endAbs: runAt + 40 },
    );
    const parent = spans.find((s) => s.id === "eval-backend-prompt-0-step-0");
    const tools = spans.find(
      (s) => s.id === "eval-backend-prompt-0-step-0-tools",
    );
    expect(tools?.endMs).toBeLessThanOrEqual(parent!.endMs);
  });

  it("backend LLM failure — error child under step", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepLlmFailureSpans(spans, runAt, 0, 0, runAt, runAt, runAt + 5);
    expect(spans.some((s) => s.category === "error")).toBe(true);
  });

  it("backend tool failure — LLM sibling then error", () => {
    const spans: EvalTraceSpan[] = [];
    pushBackendStepToolFailureSpans(
      spans,
      runAt,
      0,
      0,
      runAt,
      { startAbs: runAt, endAbs: runAt + 10 },
      runAt + 10,
      runAt + 15,
    );
    expect(spans.filter((s) => s.category === "error")).toHaveLength(1);
  });

  it("backend cost lands on the llm span only, on success and on failures", () => {
    const cost = {
      calculationVersion: 1,
      currency: "USD" as const,
      completeness: "complete" as const,
      amountUsd: 0.0021,
      source: "provider_reported" as const,
    };
    const meta = { inputTokens: 10, outputTokens: 4, totalTokens: 14, cost };
    const llm = { startAbs: runAt, endAbs: runAt + 10 };
    const success: EvalTraceSpan[] = [];
    pushBackendStepSuccessSpans(success, runAt, 0, 0, runAt, llm, undefined, meta);
    const toolFailure: EvalTraceSpan[] = [];
    pushBackendStepToolFailureSpans(
      toolFailure, runAt, 0, 0, runAt, llm, runAt + 10, runAt + 15, meta,
    );
    const llmFailure: EvalTraceSpan[] = [];
    pushBackendStepLlmFailureSpans(
      llmFailure, runAt, 0, 0, runAt, runAt, runAt + 10, meta,
    );
    for (const spans of [success, toolFailure, llmFailure]) {
      expect(spans.filter((span) => span.cost)).toEqual([
        expect.objectContaining({ category: "llm", cost, inputTokens: 10 }),
      ]);
    }
  });

  it("backend LLM failure with usage but no cost keeps an llm span without cost", () => {
    const spans: EvalTraceSpan[] = [];
    const meta = { inputTokens: 10, outputTokens: 0 };
    const end = runAt + 5;
    pushBackendStepLlmFailureSpans(spans, runAt, 0, 0, runAt, runAt, end, meta);
    const categories = spans.map((span) => span.category);
    expect(categories).toEqual(["step", "llm", "error"]);
    const llm = spans.filter((span) => span.category === "llm");
    expect(llm).toEqual([
      expect.objectContaining({ status: "error", ...meta }),
    ]);
    expect(llm[0]).not.toHaveProperty("cost");
  });

  it.each([
    ["output tokens", { outputTokens: 4 }],
    ["total tokens", { totalTokens: 14 }],
  ])(
    "backend LLM failure reporting only %s keeps an llm span",
    (_label, meta) => {
      const spans: EvalTraceSpan[] = [];
      pushBackendStepLlmFailureSpans(
        spans, runAt, 0, 0, runAt, runAt, runAt + 5, meta,
      );
      expect(spans.map((span) => span.category)).toEqual([
        "step",
        "llm",
        "error",
      ]);
    },
  );

  it("backend LLM failure with neither usage nor cost adds no llm span", () => {
    const spans: EvalTraceSpan[] = [];
    const meta = { modelId: "gpt-test" };
    const end = runAt + 5;
    pushBackendStepLlmFailureSpans(spans, runAt, 0, 0, runAt, runAt, end, meta);
    expect(spans.map((span) => span.category)).toEqual(["step", "error"]);
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
    const step = ctx.recordedSpans.find((s) => s.id === "prompt-0-step-0");
    const llm = ctx.recordedSpans.find((s) => s.id === "prompt-0-step-0-llm");
    expect(step?.category).toBe("step");
    expect(llm?.category).toBe("llm");
    expect(llm?.name).toBe("gpt-4o · response");
    expect(llm?.parentId).toBe("prompt-0-step-0");
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
      ctx
    ) as any;

    wall = runAt + 50;
    await tools.search.execute({}, { toolCallId: "tc1", messages: [] });

    wall = runAt + 120;
    emitAiSdkOnStepFinish(ctx, wall);

    const llm = ctx.recordedSpans.find((s) => s.id === "prompt-0-step-0-llm");
    const tool = ctx.recordedSpans.find((s) => s.id === "tool-tc1");
    expect(llm!.endMs - llm!.startMs).toBe(50);
    expect(tool?.name).toBe("search");
    expect(tool?.parentId).toBe("prompt-0-step-0");
  });

  it.each([
    ["a saved answer", { source: "saved" as const }, "its saved answer"],
    ["a case", { source: "saved" as const, caseIndex: 1 }, "its saved answer (case 2)"],
    [
      "a catch-all",
      { source: "saved" as const, caseIndex: 0, catchAll: true },
      "its catch-all answer (case 1, which matches any input)",
    ],
    ["its records", { source: "state" as const }, "its records"],
    ["a forward", { source: "forwarded" as const, realServerId: "s1", realTool: "say" }, "forwarded to say on server s1"],
    ["a blocked forward", { source: "blocked" as const, realTool: "say", refusal: "blocked_by_policy" }, "a forward to say was refused"],
    ["no match", { source: "unmatched" as const }, "no saved answer matched"],
  ])("AI SDK: a mock's call (%s) gets a label span under the tool, and the result is untouched", async (_name, extra, phrase) => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    // The in-process door reports to the running call, as `dispatchMockInProcess` does.
    const tools = wrapToolSetForEvalTrace(
      {
        echo: {
          description: "x",
          inputSchema: {},
          execute: async () => {
            currentMockAnswerSink()?.([{ mockId: "m1", version: 2, tool: "echo", ...extra }]);
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      },
      ctx,
    ) as any;

    const result = await tools.echo.execute({}, { toolCallId: "tc1", messages: [] });

    expect(JSON.stringify(result)).not.toMatch(/mock|m1/);
    const mark = ctx.recordedSpans.find((s) => s.parentId === "tool-tc1");
    expect(mark?.name).toContain(`Answered by the mock: ${phrase}`);
    expect(mark?.toolName).toBeUndefined();
    expect(ctx.recordedSpans.filter((s) => s.category === "tool")).toHaveLength(1);
  });

  it("AI SDK: a tool no mock handled gets no label span", async () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    const tools = wrapToolSetForEvalTrace(
      { search: { description: "x", inputSchema: {}, execute: async () => "ok" } },
      ctx,
    ) as any;
    await tools.search.execute({}, { toolCallId: "tc2", messages: [] });
    expect(ctx.recordedSpans.some((s) => s.parentId === "tool-tc2")).toBe(false);
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
    ) as any;
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

  it("AI SDK: policy-blocked tool produces no trace span", async () => {
    const ctx = createAiSdkEvalTraceContext(runAt);
    registerAiSdkPrepareStep(ctx, 0);
    const tools = wrapToolSetForEvalTrace(
      {
        blocked: {
          execute: async () => ({
            content: [{ type: "text", text: "blocked" }],
            [TOOL_POLICY_BLOCK_MARKER]: true,
          }),
        },
      },
      ctx,
    ) as any;

    const result = await tools.blocked.execute({}, { toolCallId: "tcblocked" });
    expect(result[TOOL_POLICY_BLOCK_MARKER]).toBe(true);
    expect(ctx.recordedSpans).toEqual([]);
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
    const llm = ctx.recordedSpans.find((s) => s.id === "prompt-0-step-0-llm");
    const step = ctx.recordedSpans.find((s) => s.id === "prompt-0-step-0");
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
    const llm = ctx.recordedSpans.find((s) => s.id === "prompt-0-step-0-llm");
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
    ) as any;
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
    expect(steps.map((s) => s.id)).toEqual([
      "prompt-0-step-0",
      "prompt-0-step-1",
    ]);
    expect(steps.map((s) => s.name)).toEqual(["Step 1", "Step 2"]);
  });

  it("AI SDK: same-ms timing normalization — endMs > startMs", () => {
    const spans: EvalTraceSpan[] = [];
    pushAiSdkTrailingErrorSpan(spans, runAt, runAt + 10, runAt + 10);
    expect(spans[0]!.endMs).toBeGreaterThan(spans[0]!.startMs);
  });

  it("unshifts synthetic run-setup spans ahead of captured spans", () => {
    const spans: EvalTraceSpan[] = [
      {
        id: "tool-1",
        name: "tool.search",
        category: "tool",
        startMs: 5,
        endMs: 9,
        status: "ok",
      },
    ];
    pushRunSetupSpans(spans, [
      {
        id: "run-connect-s1",
        name: "connect",
        category: "connection",
        startMs: 0,
        endMs: 12,
        status: "error",
        serverId: "s1",
      },
    ]);
    expect(spans.map((s) => s.id)).toEqual(["run-connect-s1", "tool-1"]);
  });

  it("leaves captured spans unchanged when setupSpans is empty", () => {
    const spans: EvalTraceSpan[] = [
      {
        id: "tool-1",
        name: "tool.search",
        category: "tool",
        startMs: 5,
        endMs: 9,
        status: "ok",
      },
    ];
    pushRunSetupSpans(spans, []);
    expect(spans).toEqual([
      {
        id: "tool-1",
        name: "tool.search",
        category: "tool",
        startMs: 5,
        endMs: 9,
        status: "ok",
      },
    ]);
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
        promptIndex: 0,
        stepIndex: 2,
        spans,
      },
    ) as any;

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

  it.each([
    ["a saved answer", { source: "saved" as const }, "its saved answer"],
    ["a case", { source: "saved" as const, caseIndex: 1 }, "its saved answer (case 2)"],
    [
      "a catch-all",
      { source: "saved" as const, caseIndex: 0, catchAll: true },
      "its catch-all answer (case 1, which matches any input)",
    ],
    [
      "a forward",
      { source: "forwarded" as const, realServerId: "s1", realTool: "say" },
      "forwarded to say on server s1",
    ],
  ])(
    "Playground chat: a call a mock answered (%s) is marked from the mock's response header",
    async (_name, extra, phrase) => {
      vi.spyOn(Date, "now").mockReturnValue(runAt);
      // The connection's fetch reads the mock's header, as the Playground's tool call does.
      const dial = observeMockAnswered(
        async () =>
          new Response("{}", {
            headers: {
              [MOCK_CALLS_HEADER]: formatMockCalls([
                { mockId: "m1", version: 2, tool: "say", ...extra },
              ]),
            },
          }),
      );
      const spans: EvalTraceSpan[] = [];
      const tools = wrapBackendToolsForTrace(
        {
          say: {
            execute: async () => {
              await dial("https://mock.test/m1");
              return { content: [{ type: "text", text: "ok" }] };
            },
            _serverId: "server-1",
          },
        },
        { runStartedAt: runAt, promptIndex: 0, stepIndex: 1, spans },
      ) as any;

      const result = await tools.say.execute({}, { toolCallId: "tc1" });

      expect(JSON.stringify(result)).not.toMatch(/mock|m1/);
      const tool = spans.find((s) => s.category === "tool");
      expect(mockAnswerOf(tool!, spans)).toContain(phrase);
      expect(spans.filter((s) => s.category === "tool")).toHaveLength(1);
    },
  );

  it("Playground chat: a tool no mock handled gets no mark", async () => {
    vi.spyOn(Date, "now").mockReturnValue(runAt);
    const spans: EvalTraceSpan[] = [];
    const tools = wrapBackendToolsForTrace(
      { search: { execute: async () => "ok" } },
      { runStartedAt: runAt, promptIndex: 0, stepIndex: 0, spans },
    ) as any;
    await tools.search.execute({}, { toolCallId: "tc2" });
    expect(spans).toHaveLength(1);
  });

  it("captures the JSON-RPC error code when a backend tool throws with .code", async () => {
    let wall = runAt;
    vi.spyOn(Date, "now").mockImplementation(() => wall);

    const spans: EvalTraceSpan[] = [];
    const rpcError = Object.assign(new Error("Invalid params"), {
      code: -32602,
    });
    const backendTools = wrapBackendToolsForTrace(
      {
        create_view: {
          execute: async () => {
            throw rpcError;
          },
          _serverId: "server-1",
        },
      },
      { runStartedAt: runAt, promptIndex: 0, stepIndex: 0, spans },
    ) as any;

    wall = runAt + 5;
    await expect(
      backendTools.create_view.execute({}, { toolCallId: "call-err" }),
    ).rejects.toBe(rpcError);

    // Both the tool span and the synthesized error span carry the code.
    const toolSpan = spans.find((s) => s.category === "tool");
    const errSpan = spans.find((s) => s.category === "error");
    expect(toolSpan?.status).toBe("error");
    expect(toolSpan?.mcpErrorCode).toBe(-32602);
    expect(errSpan?.mcpErrorCode).toBe(-32602);
  });

  it("leaves mcpErrorCode unset when a thrown error has no numeric code", async () => {
    let wall = runAt;
    vi.spyOn(Date, "now").mockImplementation(() => wall);

    const spans: EvalTraceSpan[] = [];
    const backendTools = wrapBackendToolsForTrace(
      {
        boom: {
          execute: async () => {
            throw new Error("plain failure");
          },
          _serverId: "server-1",
        },
      },
      { runStartedAt: runAt, promptIndex: 0, stepIndex: 0, spans },
    ) as any;

    wall = runAt + 5;
    await expect(
      backendTools.boom.execute({}, { toolCallId: "call-plain" }),
    ).rejects.toThrow("plain failure");

    const toolSpan = spans.find((s) => s.category === "tool");
    expect(toolSpan?.status).toBe("error");
    expect(toolSpan?.mcpErrorCode).toBeUndefined();
  });

  it("does not record a transport HTTP status (positive .code) as mcpErrorCode", async () => {
    let wall = runAt;
    vi.spyOn(Date, "now").mockImplementation(() => wall);

    const spans: EvalTraceSpan[] = [];
    // StreamableHTTPError / SseError carry an HTTP status on `.code` (e.g. 401).
    const httpError = Object.assign(new Error("Unauthorized"), { code: 401 });
    const backendTools = wrapBackendToolsForTrace(
      {
        secured: {
          execute: async () => {
            throw httpError;
          },
          _serverId: "server-1",
        },
      },
      { runStartedAt: runAt, promptIndex: 0, stepIndex: 0, spans },
    ) as any;

    wall = runAt + 5;
    await expect(
      backendTools.secured.execute({}, { toolCallId: "call-401" }),
    ).rejects.toBe(httpError);

    const toolSpan = spans.find((s) => s.category === "tool");
    expect(toolSpan?.status).toBe("error");
    // 401 is an HTTP status, not a JSON-RPC code — must not be recorded/mislabeled.
    expect(toolSpan?.mcpErrorCode).toBeUndefined();
  });

  it("captures SDK-local lifecycle codes too (e.g. request timeout -32001)", async () => {
    let wall = runAt;
    vi.spyOn(Date, "now").mockImplementation(() => wall);

    const spans: EvalTraceSpan[] = [];
    // MCP SDK raises McpError(RequestTimeout, -32001) client-side. We keep it
    // (negative code); the UI labels it neutrally, not as a server fault.
    const timeout = Object.assign(new Error("Request timed out"), {
      code: -32001,
    });
    const backendTools = wrapBackendToolsForTrace(
      {
        slow: {
          execute: async () => {
            throw timeout;
          },
          _serverId: "server-1",
        },
      },
      { runStartedAt: runAt, promptIndex: 0, stepIndex: 0, spans },
    ) as any;

    wall = runAt + 5;
    await expect(
      backendTools.slow.execute({}, { toolCallId: "call-timeout" }),
    ).rejects.toBe(timeout);

    const toolSpan = spans.find((s) => s.category === "tool");
    expect(toolSpan?.mcpErrorCode).toBe(-32001);
  });

  describe("a tool call that asks for sign-in", () => {
    const HEADER =
      'Bearer error="invalid_token", resource_metadata="https://x.example/.well-known/oauth-protected-resource", scope="orders:read"';

    it("AI SDK: annotates the tool span with the classified challenge, and still rethrows", async () => {
      vi.spyOn(Date, "now").mockReturnValue(runAt);
      const ctx = createAiSdkEvalTraceContext(runAt);
      registerAiSdkPrepareStep(ctx, 0);
      const refused = Object.assign(new Error("HTTP 401"), { status: 401 });
      attachAuthChallenge(refused, parseChallengeHeader(HEADER));
      const tools = wrapToolSetForEvalTrace(
        {
          list_orders: {
            _serverId: "orders",
            execute: async () => {
              throw refused;
            },
          },
        },
        ctx,
      ) as any;
      await expect(
        tools.list_orders.execute({}, { toolCallId: "tc401", messages: [] }),
      ).rejects.toBe(refused);

      const tool = ctx.recordedSpans.find((s) => s.id === "tool-tc401")!;
      expect(toolAuthChallengeOf(tool)).toMatchObject({
        setupFailureSource: "authorization_required",
        attribution: "ours",
        toolCallId: "tc401",
        toolName: "list_orders",
        serverId: "orders",
        spanId: "tool-tc401",
        promptIndex: 0,
        authChallenge: { source: "http_401", requiredScope: "orders:read" },
      });
      // The persisted span shape is unchanged: the backend validator is closed.
      expect(Object.keys(JSON.parse(JSON.stringify(tool)))).not.toContain(
        "authChallenge",
      );
      // The error span stays a plain error span.
      const err = ctx.recordedSpans.find((s) => s.id === "tool-err-tc401");
      expect(toolAuthChallengeOf(err)).toBeUndefined();
    });

    it("backend: annotates from a completed isError result carrying the _meta challenge", async () => {
      vi.spyOn(Date, "now").mockReturnValue(runAt);
      const spans: EvalTraceSpan[] = [];
      const result = {
        isError: true,
        content: [{ type: "text", text: "Sign in required." }],
        _meta: { "mcp/www_authenticate": [HEADER] },
      };
      const backendTools = wrapBackendToolsForTrace(
        {
          list_orders: {
            execute: async () => result,
            _serverId: "orders",
          },
        },
        { runStartedAt: runAt, promptIndex: 1, stepIndex: 0, spans },
      ) as any;
      // The model still gets the result unchanged.
      await expect(
        backendTools.list_orders.execute({}, { toolCallId: "tcmeta" }),
      ).resolves.toBe(result);
      const tool = spans.find((s) => s.id === "backend-tool-tcmeta")!;
      expect(tool.status).toBe("error");
      expect(toolAuthChallengeOf(tool)).toMatchObject({
        toolCallId: "tcmeta",
        promptIndex: 1,
        authChallenge: { source: "tool_result_meta" },
      });
    });

    it("leaves ordinary tool failures unannotated", async () => {
      const spans: EvalTraceSpan[] = [];
      const backendTools = wrapBackendToolsForTrace(
        {
          search: {
            execute: async () => ({
              isError: true,
              content: [{ type: "text", text: "not found" }],
            }),
          },
        },
        { runStartedAt: runAt, promptIndex: 0, stepIndex: 0, spans },
      ) as any;
      await backendTools.search.execute({}, { toolCallId: "tcplain" });
      expect(spans.every((span) => !toolAuthChallengeOf(span))).toBe(true);
    });
  });
});
