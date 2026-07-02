// Phase-4 hosted unify: the per-turn streaming SSE factory for the HOSTED eval
// path. Consumed by runHostedIterationWithBrowser's executeSteps handlers
// (via buildHostedStepHandlers' `buildSinks`).
//
// Critically this keys on the sink `ctx.promptIndex` (NOT an outer loop var):
// driveHostedEvalTurn also drives widget `ui/message` follow-up turns, where the
// follow-up's index differs from the authored turn — the inline version closed
// over the loop variable and would mislabel those.

import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { ToolCall } from "@/shared/eval-matching";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import type {
  HostedEvalTurnSinkContext,
  HostedEvalTurnSinks,
} from "./drive-hosted-eval-turn";
import type { UsageTotals } from "./types";

export interface HostedEvalSinksDeps {
  emit: (event: EvalStreamEvent) => void;
  /** Iteration-cumulative transcript (mutated by the driver across turns). */
  messageHistory: ModelMessage[];
  /** Iteration-cumulative spans. */
  capturedSpans: EvalTraceSpan[];
  /** Iteration-cumulative usage (rolled forward in place by `onStepFinish`). */
  accumulatedUsage: UsageTotals;
  withSystemPrefix: (msgs: ModelMessage[]) => ModelMessage[];
  extractToolCalls: (messages: ModelMessage[]) => ToolCall[];
  /** The runner's local `buildTraceSnapshotEvent` (unexported → passed in to avoid a cycle). */
  buildTraceSnapshotEvent: (params: {
    turnIndex: number;
    stepIndex?: number;
    snapshotKind: "step_finish" | "failure" | "turn_finish";
    messages: ModelMessage[];
    spans: EvalTraceSpan[];
    usage: UsageTotals;
    actualToolCalls: ToolCall[];
  }) => EvalStreamEvent;
}

/**
 * Returns the per-turn sink factory `driveHostedEvalTurn` calls once per turn
 * (`HostedEvalTurnSinkContext` → `HostedEvalTurnSinks`). Faithful to the former
 * inline loop body; only `promptIndex` now comes from the sink ctx.
 */
export function buildHostedEvalSinks(
  deps: HostedEvalSinksDeps,
): (ctx: HostedEvalTurnSinkContext) => HostedEvalTurnSinks {
  const {
    emit,
    messageHistory,
    capturedSpans,
    accumulatedUsage,
    withSystemPrefix,
    extractToolCalls,
    buildTraceSnapshotEvent,
  } = deps;

  return ({ promptIndex, prompt: turnPrompt, baselineUsage, traceCtx, promptToolsCalled }) => {
    let activeCompletedStepCount = 0;
    let lastSettledStepIndex: number | undefined;
    let prevStepCumulativeInput = 0;
    let prevStepCumulativeOutput = 0;

    let partialAssistantText = "";
    const partialAssistantToolCalls: Array<{
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }> = [];
    const partialToolResultMessages: ModelMessage[] = [];
    const buildPartialResponseMessages = (): ModelMessage[] => {
      const content: unknown[] = [];
      if (partialAssistantText) {
        content.push({ type: "text", text: partialAssistantText });
      }
      content.push(...partialAssistantToolCalls);
      const out: ModelMessage[] = [];
      if (content.length > 0) {
        out.push({ role: "assistant", content } as ModelMessage);
      }
      out.push(...partialToolResultMessages);
      return out;
    };

    return {
      onTurnStart: () =>
        emit({ type: "turn_start", turnIndex: promptIndex, prompt: turnPrompt }),
      onLiveTextDelta: (delta: string) => {
        if (typeof delta !== "string" || delta.length === 0) return;
        partialAssistantText += delta;
        emit({ type: "text_delta", content: delta });
      },
      onToolCall: (event) => {
        if (!event.toolName) return;
        const args = (event.input ?? {}) as Record<string, unknown>;
        promptToolsCalled.push({
          toolName: event.toolName,
          arguments: args as Record<string, any>,
        });
        partialAssistantToolCalls.push({
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: args,
        });
        emit({
          type: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args,
        });
      },
      onToolResult: (event) => {
        partialToolResultMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: event.toolCallId,
              ...(event.toolName ? { toolName: event.toolName } : {}),
              output: event.output,
              ...(event.isError ? { isError: true } : {}),
            },
          ],
        } as ModelMessage);
        emit({
          type: "tool_result",
          toolCallId: event.toolCallId,
          result: event.output,
          isError: event.isError,
        });
      },
      onStepFinish: (event) => {
        if (event.settledWithError) return;
        activeCompletedStepCount += 1;
        lastSettledStepIndex = event.stepIndex;
        const cumulativeInput = event.turnUsage?.inputTokens ?? 0;
        const cumulativeOutput = event.turnUsage?.outputTokens ?? 0;
        const cumulativeTotal = event.turnUsage?.totalTokens ?? 0;
        const stepDeltaInput = Math.max(0, cumulativeInput - prevStepCumulativeInput);
        const stepDeltaOutput = Math.max(0, cumulativeOutput - prevStepCumulativeOutput);
        prevStepCumulativeInput = cumulativeInput;
        prevStepCumulativeOutput = cumulativeOutput;
        accumulatedUsage.inputTokens = baselineUsage.inputTokens + cumulativeInput;
        accumulatedUsage.outputTokens = baselineUsage.outputTokens + cumulativeOutput;
        accumulatedUsage.totalTokens = baselineUsage.totalTokens + cumulativeTotal;
        emit({
          type: "step_finish",
          stepNumber: activeCompletedStepCount,
          usage: { inputTokens: stepDeltaInput, outputTokens: stepDeltaOutput },
        });
        const snapshotMessages = [
          ...messageHistory,
          ...buildPartialResponseMessages(),
        ];
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            stepIndex: event.stepIndex,
            snapshotKind: "step_finish",
            messages: withSystemPrefix(snapshotMessages),
            spans: [...capturedSpans, ...traceCtx.recordedSpans, ...event.turnSpans],
            actualToolCalls: extractToolCalls(snapshotMessages),
            usage: accumulatedUsage,
          })
        );
      },
      onTurnFailure: (failure) => {
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            ...(lastSettledStepIndex != null ? { stepIndex: lastSettledStepIndex } : {}),
            snapshotKind: "failure",
            messages: withSystemPrefix(messageHistory),
            spans: capturedSpans,
            actualToolCalls: extractToolCalls(messageHistory),
            usage: accumulatedUsage,
          })
        );
        emit({
          type: "error",
          message: failure.iterationError,
          ...(failure.iterationErrorDetails
            ? { details: failure.iterationErrorDetails }
            : {}),
        });
      },
      onTurnSuccess: () => {
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            snapshotKind: "turn_finish",
            messages: withSystemPrefix(messageHistory),
            spans: capturedSpans,
            actualToolCalls: extractToolCalls(messageHistory),
            usage: accumulatedUsage,
          })
        );
        emit({ type: "turn_finish", turnIndex: promptIndex });
        emit({
          type: "step_status",
          turnIndex: promptIndex,
          kind: "prompt",
          status: "ok",
        });
      },
    };
  };
}
