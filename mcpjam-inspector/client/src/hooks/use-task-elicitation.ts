import { useEffect, useState, useCallback } from "react";
import {
  TaskElicitationRequest,
  respondToTaskElicitation,
} from "@/lib/apis/mcp-tasks-api";
import { addTokenToUrl } from "@/lib/session-token";

/** A question from the local manager's global elicitation callback. */
export interface LocalElicitationRequest extends TaskElicitationRequest {
  /** The asking server's id: the client must say which server is asking. */
  serverId?: string;
}

/**
 * Subscribe to the local manager's elicitation stream
 * (`/api/mcp/elicitation/stream`) and keep the questions `accepts` claims.
 *
 * The stream carries every question the process-wide manager's global
 * callback receives, so each surface claims its own: the Tasks tab takes the
 * ones tied to a task, local chat the rest. Questions queue, since several
 * servers can ask at once and each one is still waiting server-side.
 */
function useLocalElicitationStream(
  enabled: boolean,
  accepts: (request: LocalElicitationRequest) => boolean,
) {
  const [queue, setQueue] = useState<LocalElicitationRequest[]>([]);
  const [isResponding, setIsResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptsRequest] = useState(() => accepts);

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource(addTokenToUrl("/api/mcp/elicitation/stream"));

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);

        if (data?.type === "elicitation_request") {
          const request: LocalElicitationRequest = {
            requestId: data.requestId,
            message: data.message,
            schema: data.schema,
            timestamp: data.timestamp || new Date().toISOString(),
            ...(data.relatedTaskId
              ? { relatedTaskId: data.relatedTaskId }
              : {}),
            ...(typeof data.serverId === "string"
              ? { serverId: data.serverId }
              : {}),
          };
          if (!acceptsRequest(request)) return;
          setQueue((current) =>
            current.some((r) => r.requestId === request.requestId)
              ? current
              : [...current, request],
          );
        } else if (data?.type === "elicitation_complete") {
          setQueue((current) =>
            data.requestId
              ? current.filter((r) => r.requestId !== data.requestId)
              : current.slice(1),
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
    };
  }, [enabled, acceptsRequest]);

  const elicitation = queue[0] ?? null;

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
        setQueue((current) =>
          current.filter((r) => r.requestId !== elicitation.requestId),
        );
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
    setQueue((current) => current.slice(1));
    setError(null);
  }, []);

  return { elicitation, isResponding, error, respond, clear };
}

/**
 * Hook to subscribe to task-related elicitation events via SSE.
 * Per MCP Tasks spec (2025-11-25): when a task is in input_required status,
 * the server sends elicitations with relatedTaskId in the metadata.
 */
export function useTaskElicitation(enabled: boolean = true) {
  return useLocalElicitationStream(enabled, (r) => !!r.relatedTaskId);
}

/**
 * Questions a server asks during a local chat that runs on the process-wide
 * manager (local chat without a project). That manager advertises
 * elicitation because its global callback is registered at startup, so a
 * server may ask mid-turn and waits for the answer.
 */
export function useChatElicitation(enabled: boolean = true) {
  return useLocalElicitationStream(enabled, (r) => !r.relatedTaskId);
}
