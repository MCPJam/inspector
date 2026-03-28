import type { EvalTraceSpanInput } from "./eval-reporting-types.js";

type MutableSpan = EvalTraceSpanInput;

function genSpanId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
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

export type EvalSpanSink = {
  onStepStart: (stepNumber: number, startMsHint?: number) => void;
  onToolStart: (
    toolCallId: string,
    toolName: string,
    stepNumber?: number,
    stepStartMsHint?: number
  ) => void;
  onToolEnd: (toolCallId: string) => void;
  onStepFinish: (stepNumber?: number, startMsHint?: number) => void;
  finalizeFailure: (errorLabel?: string) => void;
  getSpans: () => EvalTraceSpanInput[];
};

/**
 * Records eval timeline spans for a single TestAgent.prompt() run.
 * Times are relative to runStartedAt via rel().
 */
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
    };
    const llmSpan: MutableSpan = {
      id: llmId,
      parentId: stepId,
      name: "Model",
      category: "llm",
      startMs,
      endMs: startMs,
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
    onStepStart(stepNumber: number, startMsHint?: number) {
      ensureActiveStep(stepNumber, startMsHint);
    },

    onToolStart(
      toolCallId: string,
      toolName: string,
      stepNumber?: number,
      stepStartMsHint?: number
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
      };
      recordedSpans.push(toolSpan);
      pendingToolSpans.set(toolCallId, toolSpan);
    },

    onToolEnd(toolCallId: string) {
      const toolSpan = pendingToolSpans.get(toolCallId);
      if (!toolSpan) {
        return;
      }
      const t = rel();
      toolSpan.endMs = bumpEndMs(toolSpan.startMs, t);
      pendingToolSpans.delete(toolCallId);
    },

    onStepFinish(stepNumber?: number, startMsHint?: number) {
      if (!activeStep && stepNumber != null && stepNumber === lastFinishedStepNumber) {
        return;
      }

      ensureActiveStep(stepNumber, startMsHint);
      finalizeActiveStep(rel());
    },

    finalizeFailure(errorLabel?: string) {
      const t = rel();
      for (const [, toolSpan] of pendingToolSpans) {
        toolSpan.endMs = bumpEndMs(toolSpan.startMs, t);
      }
      pendingToolSpans.clear();
      finalizeActiveStep(t);
      recordedSpans.push({
        id: genSpanId(),
        name: errorLabel?.trim() ? errorLabel : "error",
        category: "error",
        startMs: t,
        endMs: bumpEndMs(t, t),
      });
      normalizeEvalTraceSpans(recordedSpans);
    },

    getSpans(): EvalTraceSpanInput[] {
      normalizeEvalTraceSpans(recordedSpans);
      return recordedSpans.map((s) => ({ ...s }));
    },
  };
}
