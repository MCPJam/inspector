import type {
  ModelMessage,
  TelemetryIntegration,
  OnStepStartEvent,
  OnToolCallStartEvent,
  OnToolCallFinishEvent,
  OnStepFinishEvent,
} from "ai";
import type { EvalTraceSpanInput } from "./eval-reporting-types.js";

type MutableSpan = EvalTraceSpanInput;
type SpanStatus = "ok" | "error";

type StepMeta = {
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  messageStartIndex?: number;
  messageEndIndex?: number;
  status?: SpanStatus;
};

type ToolMeta = {
  serverId?: string;
  messageStartIndex?: number;
  messageEndIndex?: number;
  status?: SpanStatus;
};

function genSpanId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `span-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function bumpEndMs(startMs: number, endMs: number): number {
  return endMs > startMs ? endMs : startMs + 1;
}

export function normalizeEvalTraceSpans(spans: MutableSpan[]): void {
  for (const s of spans) {
    s.endMs = bumpEndMs(s.startMs, s.endMs);
  }
}

function messageDedupeKey(message: ModelMessage): string {
  const id = (message as { id?: string }).id;
  if (typeof id === "string" && id) return `id:${id}`;
  try {
    return `json:${JSON.stringify(message)}`;
  } catch {
    return `fallthrough:${String((message as { role?: string }).role)}`;
  }
}

/**
 * Append messages skipping duplicates (by stable `id` or JSON identity),
 * matching PromptResult / TestAgent transcript semantics.
 */
export function appendDedupedModelMessages(
  acc: ModelMessage[],
  incoming: ModelMessage[]
): void {
  const seen = new Set(acc.map(messageDedupeKey));
  for (const m of incoming) {
    const key = messageDedupeKey(m);
    if (!seen.has(key)) {
      seen.add(key);
      acc.push(m);
    }
  }
}

/**
 * When `onStepFinish` runs with empty `step.response.messages` but `generateText` still
 * reports messages on `result.steps`, fill missing `messageStartIndex` / `messageEndIndex`
 * so timeline rows and transcript slices align with stored trace messages.
 *
 * `baseMessagesLength` is the count of messages before the first step's response messages
 * in the stored trace (TestAgent uses `[userMessage, ...result.response.messages]` → 1).
 */
export function patchEvalSpansMessageRangesFromSteps(
  spans: EvalTraceSpanInput[],
  baseMessagesLength: number,
  steps:
    | ReadonlyArray<{ response?: { messages?: ModelMessage[] } } | undefined>
    | undefined
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
  }
}

export type EvalSpanSink = {
  onStepStart: (
    stepNumber: number,
    startMsHint?: number,
    meta?: StepMeta
  ) => void;
  onToolStart: (
    toolCallId: string,
    toolName: string,
    stepNumber?: number,
    stepStartMsHint?: number,
    meta?: ToolMeta
  ) => void;
  onToolEnd: (toolCallId: string, meta?: ToolMeta) => void;
  onStepFinish: (
    stepNumber?: number,
    startMsHint?: number,
    meta?: StepMeta
  ) => void;
  finalizeFailure: (errorLabel?: string) => void;
  getSpans: () => EvalTraceSpanInput[];
};

/**
 * Records eval timeline spans for a single TestAgent.prompt() run.
 * Times are relative to runStartedAt via rel().
 */
/**
 * AI SDK TelemetryIntegration that records eval timeline spans.
 *
 * Uses native `onStepStart`, `onToolCallStart`, `onToolCallFinish`, and
 * `onStepFinish` lifecycle hooks — each provides `stepNumber` directly,
 * avoiding the synthetic-step-number bugs that arise when the execute-wrapper
 * fallback passes `undefined`.
 *
 * Message range indices are NOT set here; call `patchEvalSpansMessageRangesFromSteps`
 * after `generateText` resolves to fill them from `result.steps`.
 */
export function createEvalSpanIntegration(options: {
  /** Returns milliseconds elapsed since the prompt started. */
  rel: () => number;
  /** Map from tool name → serverId for tool span metadata. */
  serverIdByTool?: Map<string, string>;
}): TelemetryIntegration & {
  getSpans: () => EvalTraceSpanInput[];
  finalizeFailure: (errorLabel?: string) => void;
} {
  const { rel, serverIdByTool } = options;
  const sink = createEvalSpanSink(rel);

  return {
    onStepStart(event: OnStepStartEvent) {
      sink.onStepStart(event.stepNumber, rel(), {
        modelId: event.model?.modelId,
      });
    },

    onToolCallStart(event: OnToolCallStartEvent) {
      const toolName = event.toolCall.toolName;
      sink.onToolStart(
        event.toolCall.toolCallId,
        toolName,
        event.stepNumber,
        undefined,
        { serverId: serverIdByTool?.get(toolName) }
      );
    },

    onToolCallFinish(event: OnToolCallFinishEvent) {
      sink.onToolEnd(event.toolCall.toolCallId, {
        status: event.success ? "ok" : "error",
      });
    },

    onStepFinish(event: OnStepFinishEvent) {
      sink.onStepFinish(event.stepNumber, undefined, {
        modelId: event.response?.modelId ?? event.model?.modelId,
        inputTokens: event.usage?.inputTokens,
        outputTokens: event.usage?.outputTokens,
        totalTokens: event.usage?.totalTokens,
        status: "ok",
      });
    },

    finalizeFailure(errorLabel?: string) {
      sink.finalizeFailure(errorLabel);
    },

    getSpans() {
      return sink.getSpans();
    },
  };
}

export function createEvalSpanSink(rel: () => number): EvalSpanSink {
  const recordedSpans: MutableSpan[] = [];
  let activeStep: {
    stepNumber: number;
    stepSpan: MutableSpan;
    llmSpan: MutableSpan;
    llmOpen: boolean;
  } | null = null;
  let nextSyntheticStepNumber = 0;
  let lastFinishedStepNumber: number | null = null;
  const pendingToolSpans = new Map<string, MutableSpan>();

  function applyStepMeta(span: MutableSpan, meta?: StepMeta): void {
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

  function applyToolMeta(span: MutableSpan, meta?: ToolMeta): void {
    if (!meta) {
      return;
    }

    if (typeof meta.serverId === "string" && meta.serverId.length > 0) {
      span.serverId = meta.serverId;
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

  function applyStepMetaToChildren(stepSpanId: string, meta?: StepMeta): void {
    if (
      !meta ||
      typeof meta.messageStartIndex !== "number" ||
      typeof meta.messageEndIndex !== "number"
    ) {
      return;
    }

    for (const span of recordedSpans) {
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

  function closeLlmIfOpen(atMs = rel()): void {
    if (!activeStep || !activeStep.llmOpen) {
      return;
    }
    activeStep.llmSpan.endMs = bumpEndMs(activeStep.llmSpan.startMs, atMs);
    activeStep.llmOpen = false;
  }

  function finalizeActiveStep(atMs = rel()): void {
    if (!activeStep) {
      return;
    }

    closeLlmIfOpen(atMs);
    activeStep.stepSpan.endMs = bumpEndMs(activeStep.stepSpan.startMs, atMs);
    lastFinishedStepNumber = activeStep.stepNumber;
    nextSyntheticStepNumber = Math.max(
      nextSyntheticStepNumber,
      activeStep.stepNumber + 1
    );
    activeStep = null;
  }

  function openStep(stepNumber: number, startMs: number) {
    const stepId = genSpanId();
    const llmId = genSpanId();
    const stepSpan: MutableSpan = {
      id: stepId,
      name: `Step ${stepNumber + 1}`,
      category: "step",
      startMs,
      endMs: startMs,
      promptIndex: 0,
      stepIndex: stepNumber,
      status: "ok",
    };
    const llmSpan: MutableSpan = {
      id: llmId,
      parentId: stepId,
      name: "Model",
      category: "llm",
      startMs,
      endMs: startMs,
      promptIndex: 0,
      stepIndex: stepNumber,
      status: "ok",
    };
    recordedSpans.push(stepSpan, llmSpan);
    activeStep = { stepNumber, stepSpan, llmSpan, llmOpen: true };
    lastFinishedStepNumber = null;
    nextSyntheticStepNumber = Math.max(nextSyntheticStepNumber, stepNumber + 1);
    return activeStep;
  }

  function ensureActiveStep(stepNumber?: number, startMsHint?: number) {
    const resolvedStepNumber = stepNumber ?? nextSyntheticStepNumber;
    if (activeStep?.stepNumber === resolvedStepNumber) {
      return activeStep;
    }

    if (activeStep) {
      finalizeActiveStep(startMsHint ?? rel());
    }

    const startMs = Math.max(0, startMsHint ?? rel());
    return openStep(resolvedStepNumber, startMs);
  }

  return {
    onStepStart(stepNumber: number, startMsHint?: number, meta?: StepMeta) {
      const step = ensureActiveStep(stepNumber, startMsHint);
      applyStepMeta(step.stepSpan, meta);
      applyStepMeta(step.llmSpan, meta);
    },

    onToolStart(
      toolCallId: string,
      toolName: string,
      stepNumber?: number,
      stepStartMsHint?: number,
      meta?: ToolMeta
    ) {
      if (pendingToolSpans.has(toolCallId)) {
        return;
      }

      const step = ensureActiveStep(stepNumber, stepStartMsHint);
      const t = rel();
      closeLlmIfOpen(t);
      const toolSpan: MutableSpan = {
        id: genSpanId(),
        parentId: step.stepSpan.id,
        name: toolName,
        category: "tool",
        startMs: t,
        endMs: t,
        promptIndex: 0,
        stepIndex: step.stepNumber,
        toolCallId,
        toolName,
        status: "ok",
      };
      applyToolMeta(toolSpan, meta);
      recordedSpans.push(toolSpan);
      pendingToolSpans.set(toolCallId, toolSpan);
    },

    onToolEnd(toolCallId: string, meta?: ToolMeta) {
      const toolSpan = pendingToolSpans.get(toolCallId);
      if (!toolSpan) {
        return;
      }
      const t = rel();
      toolSpan.endMs = bumpEndMs(toolSpan.startMs, t);
      applyToolMeta(toolSpan, meta);
      pendingToolSpans.delete(toolCallId);
    },

    onStepFinish(stepNumber?: number, startMsHint?: number, meta?: StepMeta) {
      if (
        !activeStep &&
        stepNumber != null &&
        stepNumber === lastFinishedStepNumber
      ) {
        return;
      }

      const step = ensureActiveStep(stepNumber, startMsHint);
      applyStepMeta(step.stepSpan, meta);
      applyStepMeta(step.llmSpan, meta);
      applyStepMetaToChildren(step.stepSpan.id, meta);
      finalizeActiveStep(rel());
    },

    finalizeFailure(errorLabel?: string) {
      const t = rel();
      for (const [, toolSpan] of pendingToolSpans) {
        toolSpan.endMs = bumpEndMs(toolSpan.startMs, t);
        toolSpan.status = "error";
      }
      pendingToolSpans.clear();
      if (activeStep) {
        activeStep.stepSpan.status = "error";
        if (activeStep.llmOpen) {
          activeStep.llmSpan.status = "error";
        }
      }
      finalizeActiveStep(t);
      recordedSpans.push({
        id: genSpanId(),
        name: errorLabel?.trim() ? errorLabel : "error",
        category: "error",
        startMs: t,
        endMs: bumpEndMs(t, t),
        promptIndex: 0,
        status: "error",
      });
      normalizeEvalTraceSpans(recordedSpans);
    },

    getSpans(): EvalTraceSpanInput[] {
      normalizeEvalTraceSpans(recordedSpans);
      return recordedSpans.map((s) => ({ ...s }));
    },
  };
}
