import { useEffect, useMemo, useRef, useState } from "react";
import {
  initialEvalStreamState,
  mergeStreamingTrace,
  reduceEvalStreamEvent,
  type EvalStreamState,
} from "@/components/evals/eval-stream-reducer";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import {
  swarmEventToEvalPayload,
  type SwarmAttemptStreamStatus,
  type SwarmStreamEvent,
} from "@/shared/swarm-stream-events";
import { streamJourneyRun } from "@/lib/swarm-api";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";

export type SwarmCellLiveStatus = SwarmAttemptStreamStatus | "pending";

export type SwarmLiveSessionState = {
  envelope: {
    runId: string;
    hostId: string;
    chatSessionId: string;
    sessionIndex: number;
  };
  attemptStatus: SwarmCellLiveStatus;
  errorMessage?: string;
  stream: EvalStreamState;
};

export type JourneyRunStreamState = {
  sessions: Record<string, SwarmLiveSessionState>;
  /** Coarse matrix key: `${hostId}:${sessionIndex}` → status */
  cellStatus: Record<string, SwarmCellLiveStatus>;
  runComplete: boolean;
  connected: boolean;
  error: string | null;
};

export function swarmCellKey(hostId: string, sessionIndex: number): string {
  return `${hostId}:${sessionIndex}`;
}

function emptyRunStreamState(): JourneyRunStreamState {
  return {
    sessions: {},
    cellStatus: {},
    runComplete: false,
    connected: false,
    error: null,
  };
}

function ensureSession(
  state: JourneyRunStreamState,
  event: SwarmStreamEvent,
): SwarmLiveSessionState {
  const existing = state.sessions[event.chatSessionId];
  if (existing) return existing;
  return {
    envelope: {
      runId: event.runId,
      hostId: event.hostId,
      chatSessionId: event.chatSessionId,
      sessionIndex: event.sessionIndex,
    },
    attemptStatus: "pending",
    stream: initialEvalStreamState,
  };
}

/** Pure reducer for tests + the live hook. */
export function reduceSwarmStreamEvent(
  state: JourneyRunStreamState,
  event: SwarmStreamEvent,
): JourneyRunStreamState {
  if (event.type === "run_complete") {
    return { ...state, runComplete: true };
  }

  // Lifecycle-only events without a real session key (empty host/session).
  if (!event.chatSessionId) {
    return state;
  }

  const session = ensureSession(state, event);
  const cellKey = swarmCellKey(event.hostId, event.sessionIndex);
  let nextSession = session;
  let nextCellStatus = state.cellStatus[cellKey] ?? "pending";

  switch (event.type) {
    case "attempt_status":
    case "session_complete": {
      const status =
        event.type === "session_complete" ? event.status : event.status;
      nextCellStatus = status;
      nextSession = {
        ...session,
        attemptStatus: status,
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      };
      break;
    }
    case "session_start": {
      nextCellStatus = "running";
      nextSession = { ...session, attemptStatus: "running" };
      break;
    }
    default: {
      const payload = swarmEventToEvalPayload(event);
      if (payload) {
        nextSession = {
          ...session,
          stream: reduceEvalStreamEvent(
            session.stream,
            payload as EvalStreamEvent,
          ),
        };
      }
      break;
    }
  }

  return {
    ...state,
    sessions: {
      ...state.sessions,
      [event.chatSessionId]: nextSession,
    },
    cellStatus: {
      ...state.cellStatus,
      [cellKey]: nextCellStatus,
    },
  };
}

/**
 * Auto-connects to the journey-run SSE while `enabled` (typically when the
 * run detail is open and status is `running`). Aborts on unmount / disable /
 * `run_complete`.
 */
export function useJourneyRunStream(
  runId: string | null,
  enabled: boolean,
): JourneyRunStreamState {
  const [state, setState] = useState<JourneyRunStreamState>(emptyRunStreamState);
  const genRef = useRef(0);

  useEffect(() => {
    if (!runId || !enabled) {
      setState(emptyRunStreamState());
      return;
    }

    const gen = ++genRef.current;
    const controller = new AbortController();
    setState({
      ...emptyRunStreamState(),
      connected: true,
    });

    void streamJourneyRun(
      runId,
      (event) => {
        if (genRef.current !== gen) return;
        setState((prev) => reduceSwarmStreamEvent(prev, event));
      },
      controller.signal,
    )
      .catch((err) => {
        if (genRef.current !== gen) return;
        if (controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          connected: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      })
      .finally(() => {
        if (genRef.current !== gen) return;
        setState((prev) => ({ ...prev, connected: false }));
      });

    return () => {
      controller.abort();
    };
  }, [runId, enabled]);

  return state;
}

export function liveSessionTrace(
  session: SwarmLiveSessionState | undefined,
): TraceEnvelope | null {
  if (!session) return null;
  return mergeStreamingTrace(session.stream.trace, session.stream.draftMessages);
}

export function useLiveSessionView(
  stream: JourneyRunStreamState,
  chatSessionId: string | null,
): {
  session: SwarmLiveSessionState | undefined;
  fallbackTrace: TraceEnvelope | null;
  toolCalls: EvalStreamState["actualToolCalls"];
} {
  return useMemo(() => {
    const session = chatSessionId
      ? stream.sessions[chatSessionId]
      : undefined;
    return {
      session,
      fallbackTrace: liveSessionTrace(session),
      toolCalls: session?.stream.actualToolCalls ?? [],
    };
  }, [stream.sessions, chatSessionId]);
}
