import { useState, useEffect, useCallback, useRef } from "react";
import {
  listChatHistory,
  chatHistoryAction,
  type ChatHistorySession,
} from "@/lib/apis/web/chat-history-api";

const POLL_INTERVAL_MS = 120_000;

interface UseChatHistoryOptions {
  workspaceId?: string | null;
  enabled?: boolean;
  requestHeaders?: HeadersInit;
}

interface UseChatHistoryReturn {
  personal: ChatHistorySession[];
  workspace: ChatHistorySession[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  actions: {
    rename: (sessionId: string, customTitle: string) => Promise<void>;
    archive: (sessionId: string) => Promise<void>;
    unarchive: (sessionId: string) => Promise<void>;
    share: (sessionId: string) => Promise<void>;
    unshare: (sessionId: string) => Promise<void>;
    pin: (sessionId: string) => Promise<void>;
    unpin: (sessionId: string) => Promise<void>;
    markRead: (sessionId: string) => Promise<void>;
    markUnread: (sessionId: string) => Promise<void>;
    /** Archives every active thread in the current list (personal + workspace) in one refetch. */
    archiveAllActive: () => Promise<void>;
  };
}

export function useChatHistory({
  workspaceId,
  enabled = true,
  requestHeaders,
}: UseChatHistoryOptions): UseChatHistoryReturn {
  const [personal, setPersonal] = useState<ChatHistorySession[]>([]);
  const [workspace, setWorkspace] = useState<ChatHistorySession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchCountRef = useRef(0);

  const fetchHistory = useCallback(async () => {
    if (!enabled) return;

    const fetchId = ++fetchCountRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await listChatHistory(
        {
          workspaceId: workspaceId ?? undefined,
          status: "active",
        },
        {
          headers: requestHeaders,
        },
      );
      if (fetchId !== fetchCountRef.current) return;
      setPersonal(result.personal);
      setWorkspace(result.workspace);
    } catch (err) {
      if (fetchId !== fetchCountRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fetchId === fetchCountRef.current) {
        setLoading(false);
      }
    }
  }, [workspaceId, enabled, requestHeaders]);

  // Initial fetch and polling
  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  const performAction = useCallback(
    async (
      action: string,
      sessionId: string,
      params?: Record<string, unknown>,
    ) => {
      await chatHistoryAction(action, sessionId, params, {
        headers: requestHeaders,
      });
      await fetchHistory();
    },
    [fetchHistory, requestHeaders],
  );

  const archiveAllActive = useCallback(async () => {
    const ids = [
      ...personal.map((s) => s._id),
      ...workspace.map((s) => s._id),
    ];
    if (ids.length === 0) return;
    await Promise.all(
      ids.map((sessionId) =>
        chatHistoryAction("archive", sessionId, undefined, {
          headers: requestHeaders,
        }),
      ),
    );
    await fetchHistory();
  }, [personal, workspace, fetchHistory, requestHeaders]);

  const actions = {
    rename: (sessionId: string, customTitle: string) =>
      performAction("rename", sessionId, { customTitle }),
    archive: (sessionId: string) => performAction("archive", sessionId),
    unarchive: (sessionId: string) => performAction("unarchive", sessionId),
    share: (sessionId: string) => performAction("share", sessionId),
    unshare: (sessionId: string) => performAction("unshare", sessionId),
    pin: (sessionId: string) => performAction("pin", sessionId),
    unpin: (sessionId: string) => performAction("unpin", sessionId),
    markRead: (sessionId: string) => performAction("mark-read", sessionId),
    markUnread: (sessionId: string) => performAction("mark-unread", sessionId),
    archiveAllActive,
  };

  return {
    personal,
    workspace,
    loading,
    error,
    refetch: fetchHistory,
    actions,
  };
}
