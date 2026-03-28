import type { EvalTraceSpan } from "@/shared/eval-trace";
import { createOffsetInterval } from "@/shared/eval-trace";

/** Mutable state for `generateText` eval tracing (prepareStep + wrapped tools + onStepFinish). */
export type AiSdkEvalTraceContext = {
  runStartedAt: number;
  recordedSpans: EvalTraceSpan[];
  openSteps: Map<
    number,
    { spanId: string; startAt: number; firstToolStartAt?: number }
  >;
  openTools: Map<
    string,
    { toolName: string; stepNumber: number; startAt: number }
  >;
  lastPrepareStepNumber: number;
  prepareStepEverCalled: boolean;
  lastStepClosedEndAt: number;
};

export function createAiSdkEvalTraceContext(
  runStartedAt: number,
): AiSdkEvalTraceContext {
  return {
    runStartedAt,
    recordedSpans: [],
    openSteps: new Map(),
    openTools: new Map(),
    lastPrepareStepNumber: -1,
    prepareStepEverCalled: false,
    lastStepClosedEndAt: runStartedAt,
  };
}

/**
 * Call from `prepareStep` — aligns with AI SDK `stepNumber: steps.length` before each LLM call.
 * Replaces unavailable `experimental_onStepStart` on `generateText` in current AI SDK versions.
 */
export function registerAiSdkPrepareStep(
  ctx: AiSdkEvalTraceContext,
  stepNumber: number,
): void {
  ctx.lastPrepareStepNumber = stepNumber;
  ctx.prepareStepEverCalled = true;
  ctx.openSteps.set(stepNumber, {
    spanId: `step-${stepNumber}`,
    startAt: Date.now(),
  });
}

/**
 * Wrap tools to record per-tool wall-clock spans (`experimental_onToolCall*` are not on `generateText`).
 */
export function wrapToolSetForEvalTrace<T extends Record<string, unknown>>(
  tools: T,
  ctx: AiSdkEvalTraceContext,
): T {
  const out: Record<string, unknown> = { ...tools };
  for (const name of Object.keys(out)) {
    const raw = out[name] as {
      execute?: (
        input: unknown,
        options: {
          toolCallId: string;
          messages?: unknown;
          abortSignal?: AbortSignal;
          experimental_context?: unknown;
        },
      ) => unknown;
    };
    if (!raw || typeof raw.execute !== "function") continue;
    const origExecute = raw.execute.bind(raw);
    out[name] = {
      ...raw,
      execute: async (
        input: unknown,
        options: {
          toolCallId: string;
          messages?: unknown;
          abortSignal?: AbortSignal;
          experimental_context?: unknown;
        },
      ) => {
        const toolCallId = options.toolCallId;
        const stepNumber = ctx.lastPrepareStepNumber;
        const toolStartedAt = Date.now();
        const stepMeta = ctx.openSteps.get(stepNumber);
        const stepSpanId = stepMeta?.spanId ?? `step-${stepNumber}`;
        if (stepMeta && stepMeta.firstToolStartAt == null) {
          stepMeta.firstToolStartAt = toolStartedAt;
        }
        ctx.openTools.set(toolCallId, {
          toolName: name,
          stepNumber,
          startAt: toolStartedAt,
        });
        let success = true;
        try {
          return await origExecute(input, options);
        } catch (err) {
          success = false;
          throw err;
        } finally {
          const toolFinishedAt = Date.now();
          ctx.openTools.delete(toolCallId);
          ctx.recordedSpans.push({
            id: `tool-${toolCallId}`,
            name,
            category: "tool",
            parentId: stepSpanId,
            ...createOffsetInterval(ctx.runStartedAt, toolStartedAt, toolFinishedAt),
          });
          if (!success) {
            ctx.recordedSpans.push({
              id: `tool-err-${toolCallId}`,
              name: `${name} error`,
              category: "error",
              parentId: stepSpanId,
              ...createOffsetInterval(
                ctx.runStartedAt,
                toolStartedAt,
                toolFinishedAt,
              ),
            });
          }
        }
      },
    };
  }
  return out as T;
}

/** Emit LLM + parent step spans when a step completes (`onStepFinish`). */
export function emitAiSdkOnStepFinish(
  ctx: AiSdkEvalTraceContext,
  stepFinishedAt: number,
): void {
  const sn = ctx.lastPrepareStepNumber;
  if (sn < 0) return;
  const meta = ctx.openSteps.get(sn);
  if (!meta) return;

  const stepSpanId = meta.spanId;
  const firstTool = meta.firstToolStartAt;
  const llmEnd = firstTool ?? stepFinishedAt;

  ctx.recordedSpans.push({
    id: `${stepSpanId}-llm`,
    parentId: stepSpanId,
    name: "LLM",
    category: "llm",
    ...createOffsetInterval(ctx.runStartedAt, meta.startAt, llmEnd),
  });
  ctx.recordedSpans.push({
    id: stepSpanId,
    name: `Step ${sn + 1}`,
    category: "step",
    ...createOffsetInterval(ctx.runStartedAt, meta.startAt, stepFinishedAt),
  });

  ctx.openSteps.delete(sn);
  ctx.lastStepClosedEndAt = stepFinishedAt;
}

/**
 * On `generateText` throw: close dangling tools/steps, then append a root-level "Generation error" span.
 */
export function finalizeAiSdkTraceOnFailure(
  ctx: AiSdkEvalTraceContext,
  failAt: number,
  options: { completedStepCount: number; lastStepEndedAt: number },
): void {
  const { runStartedAt, recordedSpans, openTools, openSteps } = ctx;

  let topLevelErrorStartAbs = runStartedAt;
  if (!ctx.prepareStepEverCalled) {
    topLevelErrorStartAbs = runStartedAt;
  } else if (openSteps.size > 0) {
    topLevelErrorStartAbs = [...openSteps.values()][0]!.startAt;
  } else if (options.completedStepCount > 0) {
    topLevelErrorStartAbs = options.lastStepEndedAt;
  }

  for (const [toolCallId, t] of [...openTools.entries()]) {
    const stepSpanId = `step-${t.stepNumber}`;
    recordedSpans.push({
      id: `tool-${toolCallId}`,
      name: t.toolName,
      category: "tool",
      parentId: stepSpanId,
      ...createOffsetInterval(runStartedAt, t.startAt, failAt),
    });
    recordedSpans.push({
      id: `tool-err-${toolCallId}`,
      name: `${t.toolName} error`,
      category: "error",
      parentId: stepSpanId,
      ...createOffsetInterval(runStartedAt, t.startAt, failAt),
    });
    openTools.delete(toolCallId);
  }

  for (const [sn, meta] of [...openSteps.entries()]) {
    const stepSpanId = meta.spanId;
    const firstTool = meta.firstToolStartAt;
    if (firstTool == null) {
      recordedSpans.push({
        id: `${stepSpanId}-llm`,
        parentId: stepSpanId,
        name: "LLM",
        category: "llm",
        ...createOffsetInterval(runStartedAt, meta.startAt, failAt),
      });
    } else {
      recordedSpans.push({
        id: `${stepSpanId}-llm`,
        parentId: stepSpanId,
        name: "LLM",
        category: "llm",
        ...createOffsetInterval(runStartedAt, meta.startAt, firstTool),
      });
    }
    recordedSpans.push({
      id: stepSpanId,
      name: `Step ${sn + 1}`,
      category: "step",
      ...createOffsetInterval(runStartedAt, meta.startAt, failAt),
    });
    openSteps.delete(sn);
  }

  pushAiSdkTrailingErrorSpan(recordedSpans, runStartedAt, topLevelErrorStartAbs, failAt);
}

export function pushBackendStepSuccessSpans(
  spans: EvalTraceSpan[],
  runStartedAt: number,
  stepIndex: number,
  stepStartAbs: number,
  llm: { startAbs: number; endAbs: number },
  tools?: { startAbs: number; endAbs: number },
): void {
  const stepParentId = `eval-backend-step-${stepIndex}`;
  const label = `Step ${stepIndex + 1}`;
  const stepEndAbs = tools ? tools.endAbs : llm.endAbs;
  spans.push({
    id: stepParentId,
    name: label,
    category: "step",
    ...createOffsetInterval(runStartedAt, stepStartAbs, stepEndAbs),
  });
  spans.push({
    id: `${stepParentId}-llm`,
    parentId: stepParentId,
    name: "LLM",
    category: "llm",
    ...createOffsetInterval(runStartedAt, llm.startAbs, llm.endAbs),
  });
  if (tools) {
    spans.push({
      id: `${stepParentId}-tools`,
      parentId: stepParentId,
      name: "Tools",
      category: "tool",
      ...createOffsetInterval(
        runStartedAt,
        tools.startAbs,
        tools.endAbs,
      ),
    });
  }
}

export function pushBackendStepLlmFailureSpans(
  spans: EvalTraceSpan[],
  runStartedAt: number,
  stepIndex: number,
  stepStartAbs: number,
  llmPhaseStartAbs: number,
  failAbs: number,
): void {
  const stepParentId = `eval-backend-step-${stepIndex}`;
  const label = `Step ${stepIndex + 1}`;
  spans.push({
    id: stepParentId,
    name: label,
    category: "step",
    ...createOffsetInterval(runStartedAt, stepStartAbs, failAbs),
  });
  spans.push({
    id: `${stepParentId}-err`,
    parentId: stepParentId,
    name: "Error",
    category: "error",
    ...createOffsetInterval(runStartedAt, llmPhaseStartAbs, failAbs),
  });
}

export function pushBackendStepToolFailureSpans(
  spans: EvalTraceSpan[],
  runStartedAt: number,
  stepIndex: number,
  stepStartAbs: number,
  llm: { startAbs: number; endAbs: number },
  toolsPhaseStartAbs: number,
  failAbs: number,
): void {
  const stepParentId = `eval-backend-step-${stepIndex}`;
  const label = `Step ${stepIndex + 1}`;
  spans.push({
    id: stepParentId,
    name: label,
    category: "step",
    ...createOffsetInterval(runStartedAt, stepStartAbs, failAbs),
  });
  spans.push({
    id: `${stepParentId}-llm`,
    parentId: stepParentId,
    name: "LLM",
    category: "llm",
    ...createOffsetInterval(runStartedAt, llm.startAbs, llm.endAbs),
  });
  spans.push({
    id: `${stepParentId}-err`,
    parentId: stepParentId,
    name: "Error",
    category: "error",
    ...createOffsetInterval(runStartedAt, toolsPhaseStartAbs, failAbs),
  });
}

export function pushAiSdkTrailingErrorSpan(
  spans: EvalTraceSpan[],
  runStartedAt: number,
  errorPhaseStartAbs: number,
  failAbs: number,
): void {
  spans.push({
    id: `eval-ai-err-${failAbs}`,
    name: "Generation error",
    category: "error",
    ...createOffsetInterval(runStartedAt, errorPhaseStartAbs, failAbs),
  });
}
