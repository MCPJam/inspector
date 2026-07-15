import type { EvalTraceBlobV1 } from "@/shared/eval-trace";
import type {
  EvalStepStatus,
  EvalStreamEvent,
  EvalStreamToolCall,
} from "@/shared/eval-stream-events";
import type { TestStepKind } from "@/shared/steps";
import type { TraceEnvelope, TraceMessage } from "./trace-viewer-adapter";

/**
 * Live status for one authored step (turn granularity in v1). Keyed in
 * {@link EvalStreamState.stepStatus} by `stepId` when present, else by
 * `turn-<turnIndex>-<kind>`.
 */
export type EvalStepStatusEntry = {
  turnIndex: number;
  stepId?: string;
  kind: TestStepKind;
  status: EvalStepStatus;
  detail?: string;
};

export function stepStatusKey(entry: {
  turnIndex: number;
  stepId?: string;
  kind: TestStepKind;
}): string {
  return entry.stepId ?? `turn-${entry.turnIndex}-${entry.kind}`;
}

export type EvalStreamState = {
  trace: EvalTraceBlobV1 | null;
  draftMessages: TraceMessage[];
  actualToolCalls: EvalStreamToolCall[];
  tokensUsed: number;
  toolCallCount: number;
  currentTurnIndex: number;
  stepStatus: Record<string, EvalStepStatusEntry>;
};

export const initialEvalStreamState: EvalStreamState = {
  trace: null,
  draftMessages: [],
  actualToolCalls: [],
  tokensUsed: 0,
  toolCallCount: 0,
  currentTurnIndex: 0,
  stepStatus: {},
};

export function mergeStreamingTrace(
  trace: EvalTraceBlobV1 | null | undefined,
  draftMessages: TraceMessage[] | undefined,
): TraceEnvelope | null {
  const resolvedDraftMessages = draftMessages ?? [];
  const hasDraftMessages = resolvedDraftMessages.length > 0;

  if (!trace && !hasDraftMessages) {
    return null;
  }

  if (!trace) {
    return {
      traceVersion: 1,
      messages: resolvedDraftMessages,
    };
  }

  if (!hasDraftMessages) {
    return trace as unknown as TraceEnvelope;
  }

  return {
    ...(trace as unknown as TraceEnvelope),
    messages: [
      ...((trace.messages as unknown as TraceMessage[] | undefined) ?? []),
      ...resolvedDraftMessages,
    ],
  };
}

export function reduceEvalStreamEvent(
  state: EvalStreamState,
  event: EvalStreamEvent,
): EvalStreamState {
  switch (event.type) {
    case "turn_start": {
      return {
        ...state,
        currentTurnIndex: event.turnIndex,
        draftMessages: [
          ...state.draftMessages,
          { role: "user", content: event.prompt },
        ],
      };
    }

    case "text_delta": {
      const draftMessages = [...state.draftMessages];
      const last = draftMessages[draftMessages.length - 1];
      if (
        last &&
        last.role === "assistant" &&
        typeof last.content === "string"
      ) {
        draftMessages[draftMessages.length - 1] = {
          ...last,
          content: last.content + event.content,
        };
      } else {
        draftMessages.push({ role: "assistant", content: event.content });
      }
      return { ...state, draftMessages };
    }

    case "tool_call": {
      const draftMessages = [...state.draftMessages];
      draftMessages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
          },
        ],
      });
      return {
        ...state,
        draftMessages,
        toolCallCount: state.toolCallCount + 1,
      };
    }

    case "tool_result": {
      const draftMessages = [...state.draftMessages];
      draftMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: event.toolCallId,
            result: event.result,
            isError: event.isError,
          },
        ],
      });
      return { ...state, draftMessages };
    }

    case "step_finish": {
      return state;
    }

    case "trace_snapshot": {
      return {
        ...state,
        currentTurnIndex: event.turnIndex,
        trace: event.trace,
        draftMessages: [],
        actualToolCalls: event.actualToolCalls,
        tokensUsed: event.usage.totalTokens,
        toolCallCount: event.actualToolCalls.length,
      };
    }

    case "turn_finish": {
      return {
        ...state,
        currentTurnIndex: event.turnIndex,
      };
    }

    case "step_status": {
      const entry: EvalStepStatusEntry = {
        turnIndex: event.turnIndex,
        stepId: event.stepId,
        kind: event.kind,
        status: event.status,
        detail: event.detail,
      };
      return {
        ...state,
        stepStatus: {
          ...state.stepStatus,
          [stepStatusKey(entry)]: entry,
        },
      };
    }

    default:
      return state;
  }
}
