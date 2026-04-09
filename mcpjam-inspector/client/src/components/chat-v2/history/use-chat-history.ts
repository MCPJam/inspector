import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
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
  isReactive: boolean;
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
    /** Archives the given session ids in parallel, then refetches once. */
    archiveManySessionIds: (sessionIds: string[]) => Promise<void>;
    /** Archives every active thread in the current list (personal + workspace) in one refetch. */
    archiveAllActive: () => Promise<void>;
  };
}

type ChatHistoryActionName =
  | "rename"
  | "archive"
  | "unarchive"
  | "share"
  | "unshare"
  | "pin"
  | "unpin"
  | "mark-read"
  | "mark-unread";

export function useChatHistory({
  workspaceId,
  enabled = true,
  requestHeaders,
}: UseChatHistoryOptions): UseChatHistoryReturn {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const [personalFallback, setPersonalFallback] = useState<ChatHistorySession[]>(
    [],
  );
  const [workspaceFallback, setWorkspaceFallback] = useState<
    ChatHistorySession[]
  >([]);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const fetchCountRef = useRef(0);
  const isReactive = enabled && isAuthenticated;
  const shouldUseFallback = enabled && !isAuthenticated && !isAuthLoading;
  const reactiveQueryArgs = useMemo(
    () =>
      isReactive
        ? ({
            workspaceId: workspaceId ?? undefined,
            status: "active",
          } as const)
        : "skip",
    [isReactive, workspaceId],
  );

  const reactiveResult = useQuery(
    "directChatHistory:listCurrentHistory" as any,
    reactiveQueryArgs,
  ) as
    | {
        personal: ChatHistorySession[];
        workspace: ChatHistorySession[];
      }
    | undefined;

  const renameCurrentSession = useMutation(
    "directChatHistory:renameCurrentSession" as any,
  );
  const archiveCurrentSession = useMutation(
    "directChatHistory:archiveCurrentSession" as any,
  );
  const unarchiveCurrentSession = useMutation(
    "directChatHistory:unarchiveCurrentSession" as any,
  );
  const shareCurrentSession = useMutation(
    "directChatHistory:shareCurrentSession" as any,
  );
  const unshareCurrentSession = useMutation(
    "directChatHistory:unshareCurrentSession" as any,
  );
  const pinCurrentSession = useMutation(
    "directChatHistory:pinCurrentSession" as any,
  );
  const unpinCurrentSession = useMutation(
    "directChatHistory:unpinCurrentSession" as any,
  );
  const markCurrentSessionRead = useMutation(
    "directChatHistory:markCurrentSessionRead" as any,
  );
  const markCurrentSessionUnread = useMutation(
    "directChatHistory:markCurrentSessionUnread" as any,
  );

  const fetchHistory = useCallback(async () => {
    if (!shouldUseFallback) {
      return;
    }

    const fetchId = ++fetchCountRef.current;
    setFallbackLoading(true);
    setFallbackError(null);

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
      startTransition(() => {
        setPersonalFallback(result.personal);
        setWorkspaceFallback(result.workspace);
      });
    } catch (err) {
      if (fetchId !== fetchCountRef.current) return;
      setFallbackError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fetchId === fetchCountRef.current) {
        setFallbackLoading(false);
      }
    }
  }, [requestHeaders, shouldUseFallback, workspaceId]);

  useEffect(() => {
    if (!shouldUseFallback) {
      startTransition(() => {
        setPersonalFallback([]);
        setWorkspaceFallback([]);
        setFallbackError(null);
        setFallbackLoading(false);
      });
      return;
    }

    void fetchHistory();
    const interval = window.setInterval(() => {
      void fetchHistory();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [fetchHistory, shouldUseFallback]);

  const performReactiveAction = useCallback(
    async (
      action: ChatHistoryActionName,
      sessionId: string,
      params?: Record<string, unknown>,
    ) => {
      const payload = { sessionId: sessionId as any };
      switch (action) {
        case "rename":
          await renameCurrentSession({
            ...payload,
            customTitle: String(params?.customTitle ?? ""),
          });
          return;
        case "archive":
          await archiveCurrentSession(payload);
          return;
        case "unarchive":
          await unarchiveCurrentSession(payload);
          return;
        case "share":
          await shareCurrentSession(payload);
          return;
        case "unshare":
          await unshareCurrentSession(payload);
          return;
        case "pin":
          await pinCurrentSession(payload);
          return;
        case "unpin":
          await unpinCurrentSession(payload);
          return;
        case "mark-read":
          await markCurrentSessionRead(payload);
          return;
        case "mark-unread":
          await markCurrentSessionUnread(payload);
          return;
      }
    },
    [
      archiveCurrentSession,
      markCurrentSessionRead,
      markCurrentSessionUnread,
      pinCurrentSession,
      renameCurrentSession,
      shareCurrentSession,
      unarchiveCurrentSession,
      unpinCurrentSession,
      unshareCurrentSession,
    ],
  );

  const performAction = useCallback(
    async (
      action: ChatHistoryActionName,
      sessionId: string,
      params?: Record<string, unknown>,
    ) => {
      if (isReactive) {
        await performReactiveAction(action, sessionId, params);
        return;
      }
      await chatHistoryAction(action, sessionId, params, {
        headers: requestHeaders,
      });
      await fetchHistory();
    },
    [fetchHistory, isReactive, performReactiveAction, requestHeaders],
  );

  const archiveManySessionIds = useCallback(
    async (sessionIds: string[]) => {
      const ids = [...new Set(sessionIds)];
      if (ids.length === 0) return;
      if (isReactive) {
        await Promise.all(
          ids.map((sessionId) =>
            archiveCurrentSession({ sessionId: sessionId as any }),
          ),
        );
        return;
      }
      await Promise.all(
        ids.map((sessionId) =>
          chatHistoryAction("archive", sessionId, undefined, {
            headers: requestHeaders,
          }),
        ),
      );
      await fetchHistory();
    },
    [archiveCurrentSession, fetchHistory, isReactive, requestHeaders],
  );

  const personal = reactiveResult?.personal ?? personalFallback;
  const workspace = reactiveResult?.workspace ?? workspaceFallback;

  const archiveAllActive = useCallback(async () => {
    await archiveManySessionIds([
      ...personal.map((s) => s._id),
      ...workspace.map((s) => s._id),
    ]);
  }, [personal, workspace, archiveManySessionIds]);

  const actions = useMemo(
    () => ({
      rename: (sessionId: string, customTitle: string) =>
        performAction("rename", sessionId, { customTitle }),
      archive: (sessionId: string) => performAction("archive", sessionId),
      unarchive: (sessionId: string) => performAction("unarchive", sessionId),
      share: (sessionId: string) => performAction("share", sessionId),
      unshare: (sessionId: string) => performAction("unshare", sessionId),
      pin: (sessionId: string) => performAction("pin", sessionId),
      unpin: (sessionId: string) => performAction("unpin", sessionId),
      markRead: (sessionId: string) => performAction("mark-read", sessionId),
      markUnread: (sessionId: string) =>
        performAction("mark-unread", sessionId),
      archiveManySessionIds,
      archiveAllActive,
    }),
    [archiveAllActive, archiveManySessionIds, performAction],
  );

  const loading = isReactive
    ? reactiveResult === undefined
    : enabled && isAuthLoading
      ? true
      : fallbackLoading;
  const refetch = useCallback(() => {
    if (!isReactive) {
      void fetchHistory();
    }
  }, [fetchHistory, isReactive]);

  return {
    personal,
    workspace,
    loading,
    error: isReactive ? null : fallbackError,
    isReactive,
    refetch,
    actions,
  };
}
