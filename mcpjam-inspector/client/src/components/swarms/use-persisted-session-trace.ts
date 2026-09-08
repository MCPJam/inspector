import { useEffect, useMemo, useRef, useState } from "react";
import {
  useSessionBrowserArtifacts,
  useSharedChatThread,
  useSharedChatTurnTraces,
  useSharedChatWidgetSnapshots,
} from "@/hooks/useSharedChatThreads";
import {
  snapshotsToTraceWidgetSnapshots,
  type TraceEnvelope,
} from "@/components/evals/trace-viewer-adapter";
import {
  expectedTurnTraceSpanCount,
  hydrateTurnTraceSpans,
  SPAN_LOAD_FAILURE,
  turnTraceWallClockRange,
} from "@/components/evals/turn-trace-spans";
import type { EvalTraceSpan } from "@/shared/eval-trace";

/** One pinned plugin version recorded on a synthetic session's resume config. */
export type SessionPluginVersion = {
  pluginId: string;
  pluginVersionId: string;
  name: string;
  bundleHash: string;
};

function extractMessages(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { messages?: unknown }).messages)
  ) {
    return (data as { messages: unknown[] }).messages;
  }
  return null;
}

/**
 * Load a completed swarm session's transcript + timing spans into a
 * TraceEnvelope so Trace / Chat / Raw work after SSE has ended.
 * Mirrors blob + turn-trace hydration in {@link ShareUsageThreadDetail}.
 */
export function usePersistedSessionTrace(threadId: string | null): {
  trace: TraceEnvelope | null;
  loading: boolean;
  error: string | null;
  /**
   * The recorded spans could not be loaded, though the transcript may have
   * been. SEPARATE from `error` because it does not stop the transcript from
   * rendering — and a caller that only shows `error` in its no-trace branch
   * would swallow it in exactly the case it exists for: with no spans the
   * timeline states "No timing data recorded", a claim about the SESSION that
   * is false here. That is the BB-153 failure mode wearing a confident face.
   */
  spanError: string | null;
  /**
   * The plugin versions this synthetic session's journey target pinned (BE-5),
   * derived server-side from the run snapshot. Returned from THIS hook rather
   * than a second query because the session document it comes from is already
   * loaded here — and because a transcript and the bundle that produced it are
   * one answer, not two.
   */
  pluginVersions: SessionPluginVersion[];
} {
  const { thread } = useSharedChatThread({ threadId });
  const { traces: turnTraces } = useSharedChatTurnTraces({ threadId });
  // MCP App widget snapshots captured by the swarm runner per turn. Joined
  // into the envelope (same as ShareUsageThreadDetail) so the Chat view
  // replays the actual widget instead of collapsing to a plain tool pill.
  const { snapshots } = useSharedChatWidgetSnapshots({ threadId });
  // What the session's headless Chromium recorded: render observations,
  // Computer Use steps, and the replay `.webm`. Joined into the envelope so the
  // Replay tab and the Raw view see them, mirroring ShareUsageThreadDetail.
  const { artifacts: browserArtifacts } = useSessionBrowserArtifacts({
    threadId,
  });
  const [messages, setMessages] = useState<unknown[] | null>(null);
  const [spans, setSpans] = useState<EvalTraceSpan[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingSpans, setLoadingSpans] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Span-load failures live in their OWN slot, not in `error`.
   *
   * They used to share one, which broke in both directions: the transcript
   * effect clears `error` on every re-run, so an unrelated refetch wiped a
   * span failure, and the span effect never cleared it, so one transient
   * failure outlived the successful retry that followed it.
   */
  const [spanError, setSpanError] = useState<string | null>(null);

  // The Convex queries above re-resolve to `undefined` for a new `threadId`, but
  // everything fetched by hand below lives in state that only an effect clears —
  // one render too late. Reset during render instead, so a newly selected
  // session is never briefly shown the previous session's transcript or spans.
  const renderedThreadRef = useRef(threadId);
  if (renderedThreadRef.current !== threadId) {
    renderedThreadRef.current = threadId;
    setMessages(null);
    setSpans([]);
    setError(null);
    setSpanError(null);
    setLoadingMessages(Boolean(threadId));
    setLoadingSpans(Boolean(threadId));
  }

  useEffect(() => {
    if (!threadId || !thread?.messagesBlobUrl) {
      setMessages(null);
      setLoadingMessages(Boolean(threadId && thread === undefined));
      setError(null);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setLoadingMessages(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(thread.messagesBlobUrl!, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch messages: ${response.status}`);
        }
        const data = (await response.json()) as unknown;
        if (!active) return;
        const extracted = extractMessages(data);
        if (!extracted) {
          setMessages(null);
          setError("Transcript blob had no messages");
          return;
        }
        setMessages(extracted);
      } catch (err) {
        if (!active) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setMessages(null);
        setError(
          err instanceof Error ? err.message : "Failed to load transcript",
        );
      } finally {
        if (active) setLoadingMessages(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [threadId, thread?.messagesBlobUrl, thread]);

  useEffect(() => {
    if (!threadId) {
      setSpans([]);
      setSpanError(null);
      setLoadingSpans(false);
      return;
    }
    if (turnTraces === undefined) {
      setLoadingSpans(true);
      return;
    }
    if (turnTraces.length === 0) {
      setSpans([]);
      setSpanError(null);
      setLoadingSpans(false);
      return;
    }

    let active = true;
    setLoadingSpans(true);
    // Each attempt decides for itself: a retry that succeeds must not be
    // reported through the failure its predecessor left behind.
    setSpanError(null);
    // `hydrateTurnTraceSpans` swallows every per-blob failure and returns [],
    // so a total load failure was indistinguishable from a session that never
    // recorded spans — and the timeline then asserts the wrong one of the two:
    // `getRecordedSpans` reads [] as `undefined`, `mode` lands on "none", and
    // it prints "No timing data recorded". Stating that about a session whose
    // timing WAS recorded is the BB-153 failure mode over again.
    //
    // `spanCount` is the row's own record of what should be there, so
    // "expected some, got none" is precisely a total load failure.
    const expectedSpans = expectedTurnTraceSpanCount(turnTraces);
    void hydrateTurnTraceSpans(turnTraces)
      .then((hydrated) => {
        if (!active) return;
        setSpans(hydrated);
        if (expectedSpans > 0 && hydrated.length === 0) {
          setSpanError(SPAN_LOAD_FAILURE);
        }
      })
      .catch(() => {
        if (!active) return;
        setSpans([]);
        setSpanError(SPAN_LOAD_FAILURE);
      })
      .finally(() => {
        if (active) setLoadingSpans(false);
      });
    return () => {
      active = false;
    };
  }, [threadId, turnTraces]);

  const widgetSnapshots = useMemo(
    () => (snapshots?.length ? snapshotsToTraceWidgetSnapshots(snapshots) : []),
    [snapshots],
  );

  const renderObservations = browserArtifacts?.widgetRenderObservations ?? [];
  const interactionSteps = browserArtifacts?.browserInteractionSteps ?? [];
  const videoUrl = browserArtifacts?.videoUrl ?? null;

  // Re-anchored offsets are only half of "when did this happen": without an
  // absolute base the timeline's hover tooltip has no clock time to print, so
  // a prompt 40s into the session reads as "+40.0s" and nothing more.
  // `ShareUsageThreadDetail` has always passed one; this pane never did, which
  // left the two views of the same session disagreeing about how much they
  // could say. Rides the envelope rather than a separate return field so the
  // live/persisted choice `displayTrace` already makes carries it too.
  const wallClock = useMemo(
    () => turnTraceWallClockRange(turnTraces ?? []),
    [turnTraces],
  );

  const loading = loadingMessages || loadingSpans;
  const trace: TraceEnvelope | null =
    messages == null
      ? null
      : {
          traceVersion: 1,
          messages: messages as TraceEnvelope["messages"],
          ...(spans.length > 0 ? { spans } : {}),
          ...(wallClock.startedAtMs !== null
            ? { traceStartedAtMs: wallClock.startedAtMs }
            : {}),
          ...(wallClock.endedAtMs !== null
            ? { traceEndedAtMs: wallClock.endedAtMs }
            : {}),
          ...(widgetSnapshots.length > 0 ? { widgetSnapshots } : {}),
          ...(renderObservations.length > 0
            ? { widgetRenderObservations: renderObservations }
            : {}),
          ...(interactionSteps.length > 0
            ? { browserInteractionSteps: interactionSteps }
            : {}),
          ...(videoUrl ? { videoUrl } : {}),
        };

  return {
    trace,
    loading,
    error,
    spanError,
    pluginVersions: thread?.resumeConfig?.pluginVersions ?? [],
  };
}
