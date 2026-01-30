import { useEffect, useState, useCallback, useRef } from "react";
import { addTokenToUrl, authFetch } from "@/lib/session-token";
import type { PendingToolApproval } from "@/shared/tool-approval";

/**
 * Hook to subscribe to tool approval events via SSE.
 * When tool approval is enabled, the backend emits events requesting
 * user approval before executing each tool call.
 */
export function useToolApproval(enabled: boolean = true) {
  const [pendingApproval, setPendingApproval] =
    useState<PendingToolApproval | null>(null);
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

    const es = new EventSource(addTokenToUrl("/api/mcp/tool-approval/stream"));
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);

        if (data?.type === "tool_approval_request") {
          setPendingApproval({
            approvalId: data.approvalId,
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            toolDescription: data.toolDescription,
            parameters: data.parameters || {},
            serverName: data.serverName,
            timestamp: data.timestamp || new Date().toISOString(),
          });
        } else if (data?.type === "tool_approval_complete") {
          setPendingApproval((current) =>
            current &&
            (!data.approvalId || data.approvalId === current.approvalId)
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
      console.warn(
        "[useToolApproval] SSE connection error, browser will retry",
      );
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [enabled]);

  const respond = useCallback(
    async (action: "approve" | "deny", rememberForSession?: boolean) => {
      if (!pendingApproval) return;

      setIsResponding(true);
      setError(null);

      try {
        const response = await authFetch("/api/mcp/tool-approval/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approvalId: pendingApproval.approvalId,
            action,
            rememberForSession,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to respond to approval");
        }

        setPendingApproval(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to respond";
        setError(message);
        throw err;
      } finally {
        setIsResponding(false);
      }
    },
    [pendingApproval],
  );

  const clear = useCallback(() => {
    setPendingApproval(null);
    setError(null);
  }, []);

  return { pendingApproval, isResponding, error, respond, clear };
}
