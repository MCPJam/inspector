import type {
  EvalTraceBlobV1,
  EvalTraceBrowserInteractionStepView,
} from "@/shared/eval-trace";
import type { LiveBrowserFrame } from "@/shared/browser-live-frame";
import { liveFrameStepKey } from "@/shared/browser-live-frame";
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
  /**
   * Live browser frames, projected into the same step-view shape the persisted
   * replay uses. A SIBLING field, not part of the trace blob: `EvalTraceBlobV1`
   * carries only `videoBlobId`, and the artifact arrays live on the client
   * `TraceEnvelope` — so these merge in at envelope-build time (below) exactly
   * like the persisted arrays do. That is what lets the replay filmstrip draw a
   * run while it is still going, with no second component.
   */
  liveBrowserSteps: EvalTraceBrowserInteractionStepView[];
  /**
   * Highest live-frame `sequence` accepted so far. The frame contract promises
   * monotonicity per session precisely so a consumer can drop a late arrival —
   * without enforcing it here, a delayed frame could overwrite a newer thumbnail
   * for the same click, or land after a step that already happened, and the
   * filmstrip would move backwards.
   */
  liveBrowserFrameSequence: number;
};

export const initialEvalStreamState: EvalStreamState = {
  trace: null,
  draftMessages: [],
  actualToolCalls: [],
  tokensUsed: 0,
  toolCallCount: 0,
  currentTurnIndex: 0,
  stepStatus: {},
  liveBrowserSteps: [],
  liveBrowserFrameSequence: 0,
};

/**
 * Project a live frame onto the persisted step-view shape so one filmstrip draws
 * both. `screenshotUrl` becomes an inline data URI — the live channel carries a
 * byte-capped thumbnail rather than a storage reference, because at capture time
 * the durable upload hasn't happened yet.
 *
 * `videoOffsetMs` is deliberately absent: there is no video until the run ends,
 * so a live frame has nothing to seek and the filmstrip labels it by turn.
 */
export function liveFrameToStepView(
  frame: LiveBrowserFrame,
): EvalTraceBrowserInteractionStepView {
  return {
    toolCallId: frame.toolCallId,
    stepIndex: frame.stepIndex,
    promptIndex: frame.promptIndex,
    action: frame.action as EvalTraceBrowserInteractionStepView["action"],
    ...(frame.coordinateX !== undefined
      ? { coordinateX: frame.coordinateX }
      : {}),
    ...(frame.coordinateY !== undefined
      ? { coordinateY: frame.coordinateY }
      : {}),
    ...(frame.thumbnailBase64
      ? {
          screenshotUrl: `data:${
            frame.thumbnailMediaType ?? "image/jpeg"
          };base64,${frame.thumbnailBase64}`,
        }
      : {}),
    elapsedMs: 0,
    ts: frame.ts,
  } as EvalTraceBrowserInteractionStepView;
}

export function mergeStreamingTrace(
  trace: EvalTraceBlobV1 | null | undefined,
  draftMessages: TraceMessage[] | undefined,
  /**
   * Live browser steps to merge in as `browserInteractionSteps`. Sibling field:
   * the trace blob has no place for them, so they join the envelope here — the
   * same merge the persisted readers do.
   */
  liveBrowserSteps?: EvalTraceBrowserInteractionStepView[],
): TraceEnvelope | null {
  const resolvedDraftMessages = draftMessages ?? [];
  const hasDraftMessages = resolvedDraftMessages.length > 0;
  const hasLiveSteps = (liveBrowserSteps?.length ?? 0) > 0;
  const liveStepFields = hasLiveSteps
    ? { browserInteractionSteps: liveBrowserSteps }
    : {};

  if (!trace && !hasDraftMessages) {
    // Frames can arrive before the first trace snapshot — a widget rendered and
    // got clicked inside turn 0. Still worth an envelope, so the live Replay tab
    // opens on the first click rather than at the end of the turn.
    return hasLiveSteps
      ? { traceVersion: 1, messages: [], ...liveStepFields }
      : null;
  }

  if (!trace) {
    return {
      traceVersion: 1,
      messages: resolvedDraftMessages,
      ...liveStepFields,
    };
  }

  if (!hasDraftMessages) {
    return { ...(trace as unknown as TraceEnvelope), ...liveStepFields };
  }

  return {
    ...(trace as unknown as TraceEnvelope),
    messages: [
      ...((trace.messages as unknown as TraceMessage[] | undefined) ?? []),
      ...resolvedDraftMessages,
    ],
    ...liveStepFields,
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

    case "browser_frame": {
      // Enforce the monotonic contract: a frame that is not newer than what we
      // have is a late or replayed duplicate and must not move the view.
      if (event.frame.sequence <= state.liveBrowserFrameSequence) {
        return state;
      }
      const key = liveFrameStepKey(event.frame);
      const next = liveFrameToStepView(event.frame);
      const existingIndex = state.liveBrowserSteps.findIndex(
        (step) => `${step.toolCallId}:${step.stepIndex}` === key,
      );
      // Replace in place when a newer frame arrives for a click we already have
      // (the harness can re-shoot the same step), append otherwise. Keyed on the
      // step identity so one click can't appear twice in the filmstrip.
      const liveBrowserSteps =
        existingIndex >= 0
          ? state.liveBrowserSteps.map((step, i) =>
              i === existingIndex ? next : step,
            )
          : [...state.liveBrowserSteps, next];
      return {
        ...state,
        liveBrowserSteps,
        liveBrowserFrameSequence: event.frame.sequence,
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
