import { useEffect, useState, useCallback, useRef } from "react";
import { addTokenToUrl, authFetch } from "@/lib/session-token";
import type { PendingToolApproval } from "@/shared/tool-approval";
import { useToolApprovalStatusStore } from "@/stores/tool-approval-status-store";

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
      // Clear pending state when disabling to prevent stale dialogs
      setPendingApproval(null);
      setError(null);
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
          const completedApprovalId = data.approvalId;

          // Update the store with the final status from the server
          // This handles both user-initiated responses and server-side timeouts
          // Note: Server sends "action" for user responses, "status" for timeouts
          if (completedApprovalId) {
            const store = useToolApprovalStatusStore.getState();
            // Server may send: action="approve"/"deny" for user responses
            // or status="expired"/"timeout" for server timeouts
            const serverValue = data.action || data.status;
            let finalStatus: "approved" | "denied" | "expired" | null = null;

            if (serverValue === "approve" || serverValue === "approved") {
              finalStatus = "approved";
            } else if (serverValue === "deny" || serverValue === "denied") {
              finalStatus = "denied";
            } else if (serverValue === "expired" || serverValue === "timeout") {
              finalStatus = "expired";
            }

            if (finalStatus) {
              store.updateByApprovalId(
                completedApprovalId,
                finalStatus,
                data.rememberForSession,
              );
            }
          }

          setPendingApproval((current) =>
            current &&
            (!completedApprovalId || completedApprovalId === current.approvalId)
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
      // Clear pending state on unmount to prevent stale dialogs
      setPendingApproval(null);
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
