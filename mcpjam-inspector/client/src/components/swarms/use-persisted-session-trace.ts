import { useEffect, useState } from "react";
import {
  useSharedChatThread,
  useSharedChatTurnTraces,
  type SharedChatTurnTrace,
} from "@/hooks/useSharedChatThreads";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";
import type { EvalTraceSpan } from "@/shared/eval-trace";

/**
 * Fetch span blobs from turn trace URLs and flatten into a single span array.
 * Same contract as ShareUsageThreadDetail's hydrateSpans.
 */
async function hydrateSpans(
  traces: SharedChatTurnTrace[],
): Promise<EvalTraceSpan[]> {
  const results = await Promise.all(
    traces.map(async (trace) => {
      if (!trace.spansBlobUrl) return [];
      try {
        const response = await fetch(trace.spansBlobUrl);
        if (!response.ok) return [];
        const parsed = await response.json();
        return Array.isArray(parsed) ? (parsed as EvalTraceSpan[]) : [];
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

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
} {
  const { thread } = useSharedChatThread({ threadId });
  const { traces: turnTraces } = useSharedChatTurnTraces({ threadId });
  const [messages, setMessages] = useState<unknown[] | null>(null);
  const [spans, setSpans] = useState<EvalTraceSpan[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingSpans, setLoadingSpans] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    void hydrateSpans(turnTraces).then((hydrated) => {
      if (!active) return;
      setSpans(hydrated);
      setLoadingSpans(false);
    });
    return () => {
      active = false;
    };
  }, [threadId, turnTraces]);

  const loading = loadingMessages || loadingSpans;
  const trace: TraceEnvelope | null =
    messages == null
      ? null
      : {
          traceVersion: 1,
          messages: messages as TraceEnvelope["messages"],
          ...(spans.length > 0 ? { spans } : {}),
        };

  return { trace, loading, error };
}
