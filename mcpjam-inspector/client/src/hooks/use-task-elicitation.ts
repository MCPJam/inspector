import { useEffect, useState, useCallback, useRef } from "react";
import {
  TaskElicitationRequest,
  respondToTaskElicitation,
} from "@/lib/apis/mcp-tasks-api";
import { addTokenToUrl } from "@/lib/session-token";

/**
 * Hook to subscribe to task-related elicitation events via SSE.
 * Per MCP Tasks spec (2025-11-25): when a task is in input_required status,
 * the server sends elicitations with relatedTaskId in the metadata.
 */
export function useTaskElicitation(enabled: boolean = true) {
  const [elicitation, setElicitation] = useState<TaskElicitationRequest | null>(
    null,
  );
  const [isResponding, setIsResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    const es = new EventSource(addTokenToUrl("/api/mcp/elicitation/stream"));
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);

        if (data?.type === "elicitation_request" && data.relatedTaskId) {
          setElicitation({
            requestId: data.requestId,
            message: data.message,
            schema: data.schema,
            timestamp: data.timestamp || new Date().toISOString(),
            relatedTaskId: data.relatedTaskId,
          });
        } else if (data?.type === "elicitation_complete") {
          setElicitation((current) =>
            current && (!data.requestId || data.requestId === current.requestId)
              ? null
              : current,
          );
        }
      } catch {
        // Silently ignore malformed SSE messages
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [enabled]);

  const respond = useCallback(
    async (
      action: "accept" | "decline" | "cancel",
      content?: Record<string, unknown>,
    ) => {
      if (!elicitation) return;

      setIsResponding(true);
      setError(null);

      try {
        await respondToTaskElicitation(elicitation.requestId, action, content);
        setElicitation(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to respond";
        setError(message);
        throw err;
      } finally {
        setIsResponding(false);
      }
    },
    [elicitation],
  );

  const clear = useCallback(() => {
    setElicitation(null);
    setError(null);
  }, []);

  return { elicitation, isResponding, error, respond, clear };
}
