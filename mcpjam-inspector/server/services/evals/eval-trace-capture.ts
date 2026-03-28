import { isCallToolResultError } from "@mcpjam/sdk";
import type { EvalTraceSpan, EvalTraceSpanStatus } from "@/shared/eval-trace";
import {
  appendDedupedModelMessages,
  createOffsetInterval,
} from "@/shared/eval-trace";
import type { ModelMessage } from "ai";

type StepSpanMeta = {
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  messageStartIndex?: number;
  messageEndIndex?: number;
  status?: EvalTraceSpanStatus;
};

type ToolSpanMeta = {
  toolCallId?: string;
  serverId?: string;
  messageStartIndex?: number;
  messageEndIndex?: number;
  status?: EvalTraceSpanStatus;
};

/** Mutable state for `generateText` eval tracing (prepareStep + wrapped tools + onStepFinish). */
export type AiSdkEvalTraceContext = {
  runStartedAt: number;
  recordedSpans: EvalTraceSpan[];
  openSteps: Map<
    number,
    {
      spanId: string;
      startAt: number;
      firstToolStartAt?: number;
      modelId?: string;
    }
  >;
  openTools: Map<
    string,
    { toolName: string; stepNumber: number; startAt: number; serverId?: string }
  >;
  lastPrepareStepNumber: number;
  prepareStepEverCalled: boolean;
  lastStepClosedEndAt: number;
  recordedResponseMessageCount: number;
};

type BackendStepToolPhase = {
  startAbs: number;
  endAbs: number;
  pushAggregateSpan?: boolean;
};

/** Human-readable stored name for LLM spans (Raw JSON / exporters). */
function formatRecordedLlmSpanName(modelId?: string): string {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  return id.length > 0 ? `${id} · response` : "LLM";
}

function applyStepMeta(span: EvalTraceSpan, meta?: StepSpanMeta): void {
  if (!meta) {
    return;
  }

  if (typeof meta.modelId === "string" && meta.modelId.length > 0) {
    span.modelId = meta.modelId;
  }
  if (typeof meta.inputTokens === "number") {
    span.inputTokens = meta.inputTokens;
  }
  if (typeof meta.outputTokens === "number") {
    span.outputTokens = meta.outputTokens;
  }
  if (typeof meta.totalTokens === "number") {
    span.totalTokens = meta.totalTokens;
  }
  if (typeof meta.messageStartIndex === "number") {
    span.messageStartIndex = meta.messageStartIndex;
  }
  if (typeof meta.messageEndIndex === "number") {
    span.messageEndIndex = meta.messageEndIndex;
  }
  if (meta.status) {
    span.status = meta.status;
  }
}

function applyMessageRangeToChildren(
  spans: EvalTraceSpan[],
  stepSpanId: string,
  meta?: StepSpanMeta,
): void {
  if (
    !meta ||
    typeof meta.messageStartIndex !== "number" ||
    typeof meta.messageEndIndex !== "number"
  ) {
    return;
  }

  for (const span of spans) {
    if (span.parentId !== stepSpanId) {
      continue;
    }
    if (typeof span.messageStartIndex !== "number") {
      span.messageStartIndex = meta.messageStartIndex;
    }
    if (typeof span.messageEndIndex !== "number") {
      span.messageEndIndex = meta.messageEndIndex;
    }
  }
}

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
    recordedResponseMessageCount: 0,
  };
}

/**
 * Call from `prepareStep` — aligns with AI SDK `stepNumber: steps.length` before each LLM call.
 * Replaces unavailable `experimental_onStepStart` on `generateText` in current AI SDK versions.
 */
export function registerAiSdkPrepareStep(
  ctx: AiSdkEvalTraceContext,
  stepNumber: number,
  meta?: Pick<StepSpanMeta, "modelId">,
): void {
  ctx.lastPrepareStepNumber = stepNumber;
  ctx.prepareStepEverCalled = true;
  ctx.openSteps.set(stepNumber, {
    spanId: `step-${stepNumber}`,
    startAt: Date.now(),
    modelId: meta?.modelId,
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
    const serverId =
      typeof (raw as { _serverId?: unknown })._serverId === "string"
        ? ((raw as { _serverId?: string })._serverId ?? undefined)
        : undefined;
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
          serverId,
        });
        let success = true;
        try {
          const result = await origExecute(input, options);
          if (isCallToolResultError(result)) {
            success = false;
          }
          return result;
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
            promptIndex: 0,
            stepIndex: stepNumber,
            toolCallId,
            toolName: name,
            serverId,
            status: success ? "ok" : "error",
            ...createOffsetInterval(
              ctx.runStartedAt,
              toolStartedAt,
              toolFinishedAt,
            ),
          });
          if (!success) {
            ctx.recordedSpans.push({
              id: `tool-err-${toolCallId}`,
              name: `${name} error`,
              category: "error",
              parentId: stepSpanId,
              promptIndex: 0,
              stepIndex: stepNumber,
              toolCallId,
              toolName: name,
              serverId,
              status: "error",
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
  spanMeta?: StepSpanMeta,
): void {
  const sn = ctx.lastPrepareStepNumber;
  if (sn < 0) return;
  const stepMeta = ctx.openSteps.get(sn);
  if (!stepMeta) return;

  const stepSpanId = stepMeta.spanId;
  const firstTool = stepMeta.firstToolStartAt;
  const llmEnd = firstTool ?? stepFinishedAt;
  const resolvedModelId = spanMeta?.modelId ?? stepMeta.modelId;

  const llmSpan: EvalTraceSpan = {
    id: `${stepSpanId}-llm`,
    parentId: stepSpanId,
    name: formatRecordedLlmSpanName(resolvedModelId),
    category: "llm",
    promptIndex: 0,
    stepIndex: sn,
    status: spanMeta?.status ?? "ok",
    ...createOffsetInterval(ctx.runStartedAt, stepMeta.startAt, llmEnd),
  };
  applyStepMeta(llmSpan, {
    modelId: spanMeta?.modelId ?? stepMeta.modelId,
    inputTokens: spanMeta?.inputTokens,
    outputTokens: spanMeta?.outputTokens,
    totalTokens: spanMeta?.totalTokens,
    messageStartIndex: spanMeta?.messageStartIndex,
    messageEndIndex: spanMeta?.messageEndIndex,
    status: spanMeta?.status ?? "ok",
  });
  ctx.recordedSpans.push(llmSpan);

  const stepSpan: EvalTraceSpan = {
    id: stepSpanId,
    name: `Step ${sn + 1}`,
    category: "step",
    promptIndex: 0,
    stepIndex: sn,
    status: spanMeta?.status ?? "ok",
    ...createOffsetInterval(ctx.runStartedAt, stepMeta.startAt, stepFinishedAt),
  };
  applyStepMeta(stepSpan, {
    modelId: spanMeta?.modelId ?? stepMeta.modelId,
    inputTokens: spanMeta?.inputTokens,
    outputTokens: spanMeta?.outputTokens,
    totalTokens: spanMeta?.totalTokens,
    messageStartIndex: spanMeta?.messageStartIndex,
    messageEndIndex: spanMeta?.messageEndIndex,
    status: spanMeta?.status ?? "ok",
  });
  ctx.recordedSpans.push(stepSpan);
  applyMessageRangeToChildren(ctx.recordedSpans, stepSpanId, {
    messageStartIndex: spanMeta?.messageStartIndex,
    messageEndIndex: spanMeta?.messageEndIndex,
  });

  if (typeof spanMeta?.messageEndIndex === "number") {
    ctx.recordedResponseMessageCount = Math.max(
      ctx.recordedResponseMessageCount,
      spanMeta.messageEndIndex + 1,
    );
  }

  ctx.openSteps.delete(sn);
  ctx.lastStepClosedEndAt = stepFinishedAt;
}

/**
 * After `generateText` resolves: fill missing `messageStartIndex` / `messageEndIndex` on spans when
 * `onStepFinish` saw an empty `step.response.messages` array but `result.steps` still carries the
 * assistant messages. Replays the same dedupe rules as the eval runner's `onStepFinish` handler so
 * indices line up with `[...baseMessages, ...finalResponseMessages]`.
 */
export function patchAiSdkRecordedSpansMessageRangesFromSteps(
  spans: EvalTraceSpan[],
  baseMessagesLength: number,
  steps:
    | ReadonlyArray<{ response?: { messages?: ModelMessage[] } } | undefined>
    | undefined,
): void {
  if (!steps || steps.length === 0) {
    return;
  }

  const acc: ModelMessage[] = [];
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const responseMessages = steps[stepIndex]?.response?.messages ?? [];
    const beforeLen = acc.length;
    appendDedupedModelMessages(acc, responseMessages);
    const afterLen = acc.length;
    if (afterLen === beforeLen) {
      continue;
    }

    const start = baseMessagesLength + beforeLen;
    const end = baseMessagesLength + afterLen - 1;
    const stepSpanId = `step-${stepIndex}`;

    for (const span of spans) {
      if (span.stepIndex !== stepIndex) {
        continue;
      }
      if (
        typeof span.messageStartIndex === "number" &&
        typeof span.messageEndIndex === "number"
      ) {
        continue;
      }
      span.messageStartIndex = start;
      span.messageEndIndex = end;
    }

    for (const span of spans) {
      if (span.parentId !== stepSpanId) {
        continue;
      }
      if (
        typeof span.messageStartIndex === "number" &&
        typeof span.messageEndIndex === "number"
      ) {
        continue;
      }
      span.messageStartIndex = start;
      span.messageEndIndex = end;
    }
  }
}

/**
 * On `generateText` throw: close dangling tools/steps, then append a root-level "Generation error" span.
 */
export function finalizeAiSdkTraceOnFailure(
  ctx: AiSdkEvalTraceContext,
  failAt: number,
  options: {
    completedStepCount: number;
    lastStepEndedAt: number;
    modelId?: string;
  },
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
      promptIndex: 0,
      stepIndex: t.stepNumber,
      toolCallId,
      toolName: t.toolName,
      serverId: t.serverId,
      status: "error",
      ...createOffsetInterval(runStartedAt, t.startAt, failAt),
    });
    recordedSpans.push({
      id: `tool-err-${toolCallId}`,
      name: `${t.toolName} error`,
      category: "error",
      parentId: stepSpanId,
      promptIndex: 0,
      stepIndex: t.stepNumber,
      toolCallId,
      toolName: t.toolName,
      serverId: t.serverId,
      status: "error",
      ...createOffsetInterval(runStartedAt, t.startAt, failAt),
    });
    openTools.delete(toolCallId);
  }

  for (const [sn, meta] of [...openSteps.entries()]) {
    const stepSpanId = meta.spanId;
    const firstTool = meta.firstToolStartAt;
    const failModelId = meta.modelId ?? options.modelId;
    if (firstTool == null) {
      recordedSpans.push({
        id: `${stepSpanId}-llm`,
        parentId: stepSpanId,
        name: formatRecordedLlmSpanName(failModelId),
        category: "llm",
        promptIndex: 0,
        stepIndex: sn,
        status: "error",
        modelId: failModelId,
        ...createOffsetInterval(runStartedAt, meta.startAt, failAt),
      });
    } else {
      recordedSpans.push({
        id: `${stepSpanId}-llm`,
        parentId: stepSpanId,
        name: formatRecordedLlmSpanName(failModelId),
        category: "llm",
        promptIndex: 0,
        stepIndex: sn,
        status: "ok",
        modelId: failModelId,
        ...createOffsetInterval(runStartedAt, meta.startAt, firstTool),
      });
    }
    recordedSpans.push({
      id: stepSpanId,
      name: `Step ${sn + 1}`,
      category: "step",
      promptIndex: 0,
      stepIndex: sn,
      status: "error",
      modelId: meta.modelId ?? options.modelId,
      ...createOffsetInterval(runStartedAt, meta.startAt, failAt),
    });
    openSteps.delete(sn);
  }

  pushAiSdkTrailingErrorSpan(
    recordedSpans,
    runStartedAt,
    topLevelErrorStartAbs,
    failAt,
  );
}

export function pushBackendStepSuccessSpans(
  spans: EvalTraceSpan[],
  runStartedAt: number,
  stepIndex: number,
  stepStartAbs: number,
  llm: { startAbs: number; endAbs: number },
  tools?: BackendStepToolPhase,
  meta?: StepSpanMeta,
): void {
  const stepParentId = `eval-backend-step-${stepIndex}`;
  const label = `Step ${stepIndex + 1}`;
  const stepEndAbs = tools ? tools.endAbs : llm.endAbs;
  const stepSpan: EvalTraceSpan = {
    id: stepParentId,
    name: label,
    category: "step",
    promptIndex: 0,
    stepIndex,
    status: meta?.status ?? "ok",
    ...createOffsetInterval(runStartedAt, stepStartAbs, stepEndAbs),
  };
  applyStepMeta(stepSpan, meta);
  spans.push(stepSpan);

  const llmSpan: EvalTraceSpan = {
    id: `${stepParentId}-llm`,
    parentId: stepParentId,
    name: formatRecordedLlmSpanName(meta?.modelId),
    category: "llm",
    promptIndex: 0,
    stepIndex,
    status: meta?.status ?? "ok",
    ...createOffsetInterval(runStartedAt, llm.startAbs, llm.endAbs),
  };
  applyStepMeta(llmSpan, meta);
  spans.push(llmSpan);

  if (tools && tools.pushAggregateSpan !== false) {
    spans.push({
      id: `${stepParentId}-tools`,
      parentId: stepParentId,
      name: "Tools (aggregate)",
      category: "tool",
      promptIndex: 0,
      stepIndex,
      status: meta?.status ?? "ok",
      ...createOffsetInterval(runStartedAt, tools.startAbs, tools.endAbs),
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
  meta?: StepSpanMeta,
): void {
  const stepParentId = `eval-backend-step-${stepIndex}`;
  const label = `Step ${stepIndex + 1}`;
  const stepSpan: EvalTraceSpan = {
    id: stepParentId,
    name: label,
    category: "step",
    promptIndex: 0,
    stepIndex,
    status: "error",
    ...createOffsetInterval(runStartedAt, stepStartAbs, failAbs),
  };
  applyStepMeta(stepSpan, { ...meta, status: "error" });
  spans.push(stepSpan);
  spans.push({
    id: `${stepParentId}-err`,
    parentId: stepParentId,
    name: "Error",
    category: "error",
    promptIndex: 0,
    stepIndex,
    status: "error",
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
  meta?: StepSpanMeta & { pushAggregateSpan?: boolean },
): void {
  const stepParentId = `eval-backend-step-${stepIndex}`;
  const label = `Step ${stepIndex + 1}`;
  const stepSpan: EvalTraceSpan = {
    id: stepParentId,
    name: label,
    category: "step",
    promptIndex: 0,
    stepIndex,
    status: "error",
    ...createOffsetInterval(runStartedAt, stepStartAbs, failAbs),
  };
  applyStepMeta(stepSpan, { ...meta, status: "error" });
  spans.push(stepSpan);

  const llmSpan: EvalTraceSpan = {
    id: `${stepParentId}-llm`,
    parentId: stepParentId,
    name: formatRecordedLlmSpanName(meta?.modelId),
    category: "llm",
    promptIndex: 0,
    stepIndex,
    status: "ok",
    ...createOffsetInterval(runStartedAt, llm.startAbs, llm.endAbs),
  };
  applyStepMeta(llmSpan, meta);
  spans.push(llmSpan);

  if (meta?.pushAggregateSpan !== false) {
    spans.push({
      id: `${stepParentId}-err`,
      parentId: stepParentId,
      name: "Error",
      category: "error",
      promptIndex: 0,
      stepIndex,
      status: "error",
      ...createOffsetInterval(runStartedAt, toolsPhaseStartAbs, failAbs),
    });
  }
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
    promptIndex: 0,
    status: "error",
    ...createOffsetInterval(runStartedAt, errorPhaseStartAbs, failAbs),
  });
}

export function wrapBackendToolsForTrace<T extends Record<string, unknown>>(
  tools: T,
  params: {
    runStartedAt: number;
    stepIndex: number;
    spans: EvalTraceSpan[];
  },
): T {
  const out: Record<string, unknown> = { ...tools };

  for (const name of Object.keys(out)) {
    const raw = out[name] as {
      execute?: (
        input: unknown,
        options?: {
          toolCallId?: string;
          messages?: unknown;
        },
      ) => unknown;
      _serverId?: string;
    };
    if (!raw || typeof raw.execute !== "function") {
      continue;
    }

    const origExecute = raw.execute.bind(raw);
    out[name] = {
      ...raw,
      execute: async (
        input: unknown,
        options?: {
          toolCallId?: string;
          messages?: unknown;
        },
      ) => {
        const startedAt = Date.now();
        const toolCallId =
          typeof options?.toolCallId === "string" &&
          options.toolCallId.length > 0
            ? options.toolCallId
            : `backend-tool-${params.stepIndex}-${startedAt}`;
        let success = true;
        try {
          const result = await origExecute(input, options);
          if (isCallToolResultError(result)) {
            success = false;
          }
          return result;
        } catch (error) {
          success = false;
          throw error;
        } finally {
          const finishedAt = Date.now();
          params.spans.push({
            id: `backend-tool-${toolCallId}`,
            parentId: `eval-backend-step-${params.stepIndex}`,
            name,
            category: "tool",
            promptIndex: 0,
            stepIndex: params.stepIndex,
            toolCallId,
            toolName: name,
            serverId: raw._serverId,
            status: success ? "ok" : "error",
            ...createOffsetInterval(params.runStartedAt, startedAt, finishedAt),
          });
          if (!success) {
            params.spans.push({
              id: `backend-tool-err-${toolCallId}`,
              parentId: `eval-backend-step-${params.stepIndex}`,
              name: `${name} error`,
              category: "error",
              promptIndex: 0,
              stepIndex: params.stepIndex,
              toolCallId,
              toolName: name,
              serverId: raw._serverId,
              status: "error",
              ...createOffsetInterval(
                params.runStartedAt,
                startedAt,
                finishedAt,
              ),
            });
          }
        }
      },
    };
  }

  return out as T;
}
