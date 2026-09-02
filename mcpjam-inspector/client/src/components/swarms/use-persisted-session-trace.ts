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
import { hydrateTurnTraceSpans } from "@/components/evals/turn-trace-spans";
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
      setLoadingSpans(false);
      return;
    }
    if (turnTraces === undefined) {
      setLoadingSpans(true);
      return;
    }
    if (turnTraces.length === 0) {
      setSpans([]);
      setLoadingSpans(false);
      return;
    }

    let active = true;
    setLoadingSpans(true);
    // `hydrateTurnTraceSpans` swallows every per-blob failure and returns [],
    // so a total load failure was indistinguishable from a session that never
    // recorded spans — and that is not a blank timeline: `getRecordedSpans`
    // reads [] as `undefined`, so the viewer silently falls back to the
    // SYNTHESIZED `estimatedDurationMs` trace. A confident, entirely estimated
    // timeline is the BB-153 failure mode over again.
    //
    // `spanCount` is the row's own record of what should be there, so
    // "expected some, got none" is precisely a total load failure.
    const expectedSpans = turnTraces.reduce(
      (total, trace) => total + (trace.spanCount ?? 0),
      0,
    );
    void hydrateTurnTraceSpans(turnTraces)
      .then((hydrated) => {
        if (!active) return;
        setSpans(hydrated);
        if (expectedSpans > 0 && hydrated.length === 0) {
          setError("Could not load the recorded trace for this session");
        }
      })
      .catch(() => {
        if (!active) return;
        setSpans([]);
        setError("Could not load the recorded trace for this session");
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

  const loading = loadingMessages || loadingSpans;
  const trace: TraceEnvelope | null =
    messages == null
      ? null
      : {
          traceVersion: 1,
          messages: messages as TraceEnvelope["messages"],
          ...(spans.length > 0 ? { spans } : {}),
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
    pluginVersions: thread?.resumeConfig?.pluginVersions ?? [],
  };
}
