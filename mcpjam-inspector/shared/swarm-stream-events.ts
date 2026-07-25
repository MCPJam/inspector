import type { EvalTraceBlobV1 } from "./eval-trace";

/**
 * Attempt / session terminal states reported on the swarm SSE multiplex.
 * Mirrors journey-execution attempt statuses the fan-out runner already writes
 * to Convex.
 */
export type SwarmAttemptStreamStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rate_limited";

export type SwarmStreamToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

/**
 * Scoping envelope on every swarm stream event. A single journey-run SSE
 * multiplexes N concurrent host sessions; clients partition by `chatSessionId`.
 */
export type SwarmStreamEnvelope = {
  runId: string;
  hostId: string;
  /**
   * Opaque execution-target id (Project Environments). Present on events from
   * env-aware runners; absent on legacy/historical streams. ADDITIVE: `hostId`
   * is kept for compatibility, but third-party SSE readers keying on hostId
   * alone will merge two same-host targets — key on `targetId ?? hostId`.
   */
  targetId?: string;
  chatSessionId: string;
  sessionIndex: number;
};

/** Eval-shaped per-turn / per-step payloads (no authored step_status). */
export type SwarmStreamTurnPayload =
  | { type: "turn_start"; turnIndex: number; prompt: string }
  | { type: "text_delta"; content: string }
  | {
      type: "tool_call";
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      result: unknown;
      isError?: boolean;
    }
  | {
      type: "step_finish";
      stepNumber: number;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      type: "trace_snapshot";
      turnIndex: number;
      stepIndex?: number;
      snapshotKind: "step_finish" | "turn_finish" | "failure";
      trace: EvalTraceBlobV1;
      actualToolCalls: SwarmStreamToolCall[];
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }
  | { type: "turn_finish"; turnIndex: number }
  | { type: "error"; message: string; details?: string };

/** Swarm-only lifecycle events (no eval equivalent). */
export type SwarmStreamLifecyclePayload =
  | { type: "session_start" }
  | {
      type: "session_complete";
      status: Exclude<SwarmAttemptStreamStatus, "pending" | "running">;
      errorMessage?: string;
    }
  | {
      type: "attempt_status";
      status: SwarmAttemptStreamStatus;
      errorMessage?: string;
    }
  | { type: "run_complete" };

export type SwarmStreamPayload =
  | SwarmStreamTurnPayload
  | SwarmStreamLifecyclePayload;

export type SwarmStreamEvent = SwarmStreamEnvelope & SwarmStreamPayload;

/**
 * Strip the swarm envelope so the leftover payload can be fed into the eval
 * stream reducer (turn/text/tool events). Lifecycle events return null.
 */
export function swarmEventToEvalPayload(
  event: SwarmStreamEvent,
): SwarmStreamTurnPayload | null {
  switch (event.type) {
    case "turn_start":
      return {
        type: "turn_start",
        turnIndex: event.turnIndex,
        prompt: event.prompt,
      };
    case "text_delta":
      return { type: "text_delta", content: event.content };
    case "tool_call":
      return {
        type: "tool_call",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      };
    case "step_finish":
      return {
        type: "step_finish",
        stepNumber: event.stepNumber,
        usage: event.usage,
      };
    case "trace_snapshot":
      return {
        type: "trace_snapshot",
        turnIndex: event.turnIndex,
        stepIndex: event.stepIndex,
        snapshotKind: event.snapshotKind,
        trace: event.trace,
        actualToolCalls: event.actualToolCalls,
        usage: event.usage,
      };
    case "turn_finish":
      return { type: "turn_finish", turnIndex: event.turnIndex };
    case "error":
      return {
        type: "error",
        message: event.message,
        details: event.details,
      };
    case "session_start":
    case "session_complete":
    case "attempt_status":
    case "run_complete":
      return null;
  }
}
