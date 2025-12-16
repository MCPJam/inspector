import { useEffect, useState, useCallback, useRef } from "react";
import {
  TaskElicitationRequest,
  respondToTaskElicitation,
} from "@/lib/apis/mcp-tasks-api";

/**
 * Hook to subscribe to task-related elicitation events via SSE.
 * Per MCP Tasks spec (2025-11-25): when a task is in input_required status,
 * the server sends elicitations with relatedTaskId in the metadata.
 */
export function useTaskElicitation(
  /** Task IDs to filter elicitations for. If provided, only elicitations for these tasks are captured. */
  taskIds?: string[],
  /** Whether to enable the SSE subscription */
  enabled: boolean = true,
) {
  const [elicitation, setElicitation] = useState<TaskElicitationRequest | null>(
    null,
  );
  const [isResponding, setIsResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Track task IDs in a ref to avoid reconnecting on every change
  const taskIdsRef = useRef<string[]>([]);
  taskIdsRef.current = taskIds ?? [];

  useEffect(() => {
    if (!enabled) {
      // Clean up if disabled
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Create SSE connection to elicitation stream
    const es = new EventSource("/api/mcp/elicitation/stream");
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);

        if (data?.type === "elicitation_request") {
          const request: TaskElicitationRequest = {
            requestId: data.requestId,
            message: data.message,
            schema: data.schema,
            timestamp: data.timestamp || new Date().toISOString(),
            relatedTaskId: data.relatedTaskId,
          };

          // If taskIds filter is set, only accept elicitations for those tasks
          if (taskIdsRef.current.length > 0) {
            if (
              request.relatedTaskId &&
              taskIdsRef.current.includes(request.relatedTaskId)
            ) {
              setElicitation(request);
            }
          } else {
            // No filter, accept all task-related elicitations
            if (request.relatedTaskId) {
              setElicitation(request);
            }
          }
        } else if (data?.type === "elicitation_complete") {
          // Clear elicitation when completed
          if (
            elicitation &&
            (!data.requestId || data.requestId === elicitation.requestId)
          ) {
            setElicitation(null);
          }
        }
      } catch (err) {
        console.debug("[useTaskElicitation] Failed to parse SSE message:", err);
      }
    };

    es.onerror = (err) => {
      console.debug("[useTaskElicitation] SSE connection error:", err);
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
      if (!elicitation) {
        return;
      }

      setIsResponding(true);
      setError(null);

      try {
        await respondToTaskElicitation(elicitation.requestId, action, content);
        setElicitation(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to respond to elicitation";
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

  return {
    /** Current active elicitation request */
    elicitation,
    /** Whether a response is being sent */
    isResponding,
    /** Error message if response failed */
    error,
    /** Send a response to the current elicitation */
    respond,
    /** Clear the current elicitation without responding */
    clear,
  };
}
