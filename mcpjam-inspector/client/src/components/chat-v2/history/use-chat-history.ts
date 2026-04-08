import { useState, useEffect, useCallback, useRef } from "react";
import {
  listChatHistory,
  chatHistoryAction,
  type ChatHistorySession,
} from "@/lib/apis/web/chat-history-api";

const POLL_INTERVAL_MS = 30_000;

interface UseChatHistoryOptions {
  workspaceId?: string | null;
  enabled?: boolean;
}

interface UseChatHistoryReturn {
  personal: ChatHistorySession[];
  workspace: ChatHistorySession[];
  loading: boolean;
  error: string | null;
  activeStatus: "active" | "archived";
  setActiveStatus: (status: "active" | "archived") => void;
  refetch: () => void;
  actions: {
    rename: (sessionId: string, customTitle: string) => Promise<void>;
    archive: (sessionId: string) => Promise<void>;
    unarchive: (sessionId: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    share: (sessionId: string) => Promise<void>;
    unshare: (sessionId: string) => Promise<void>;
    pin: (sessionId: string) => Promise<void>;
    unpin: (sessionId: string) => Promise<void>;
    markRead: (sessionId: string) => Promise<void>;
    markUnread: (sessionId: string) => Promise<void>;
  };
}

export function useChatHistory({
  workspaceId,
  enabled = true,
}: UseChatHistoryOptions): UseChatHistoryReturn {
  const [personal, setPersonal] = useState<ChatHistorySession[]>([]);
  const [workspace, setWorkspace] = useState<ChatHistorySession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<"active" | "archived">(
    "active",
  );
  const fetchCountRef = useRef(0);

  const fetchHistory = useCallback(async () => {
    if (!enabled) return;

    const fetchId = ++fetchCountRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await listChatHistory({
        workspaceId: workspaceId ?? undefined,
        status: activeStatus,
      });
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
  }, [workspaceId, activeStatus, enabled]);

  // Initial fetch and polling
  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  const performAction = useCallback(
    async (action: string, sessionId: string, params?: Record<string, unknown>) => {
      await chatHistoryAction(action, sessionId, params);
      await fetchHistory();
    },
    [fetchHistory],
  );

  const actions = {
    rename: (sessionId: string, customTitle: string) =>
      performAction("rename", sessionId, { customTitle }),
    archive: (sessionId: string) => performAction("archive", sessionId),
    unarchive: (sessionId: string) => performAction("unarchive", sessionId),
    deleteSession: (sessionId: string) => performAction("delete", sessionId),
    share: (sessionId: string) => performAction("share", sessionId),
    unshare: (sessionId: string) => performAction("unshare", sessionId),
    pin: (sessionId: string) => performAction("pin", sessionId),
    unpin: (sessionId: string) => performAction("unpin", sessionId),
    markRead: (sessionId: string) => performAction("mark-read", sessionId),
    markUnread: (sessionId: string) => performAction("mark-unread", sessionId),
  };

  return {
    personal,
    workspace,
    loading,
    error,
    activeStatus,
    setActiveStatus,
    refetch: fetchHistory,
    actions,
  };
}
