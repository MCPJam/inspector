import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatHistoryRow } from "./ChatHistoryRow";
import { useChatHistory } from "./use-chat-history";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import {
  buildWorkspaceOwnerProfileByUserId,
  resolveWorkspaceThreadOwnerAvatar,
} from "./workspace-thread-owner-avatar";

/** Delays (ms) after a turn completes to re-fetch list while backend ingestion may still be running. */
const HISTORY_REFETCH_RETRY_DELAYS_MS = [250, 800, 2000] as const;

interface ChatHistoryRailProps {
  activeSessionId?: string | null;
  isAuthenticated: boolean;
  isStreaming: boolean;
  workspaceId?: string | null;
  requestHeaders?: HeadersInit;
  enabled?: boolean;
  refreshSignal?: number;
  onSelectThread: (session: ChatHistorySession) => void;
  onNewChat: () => void;
  /** If the user has an active thread selected, run before archiving all (e.g. draft discard confirm). */
  beforeResetChatAfterArchiveAll?: () => boolean;
  /** After a successful archive-all, use this to clear the main chat if a history thread was active. */
  onArchiveAllComplete?: (hadActiveHistorySelection: boolean) => void;
  onSessionAction?: (event: {
    action:
      | "rename"
      | "archive"
      | "unarchive"
      | "share"
      | "unshare"
      | "pin"
      | "unpin"
      | "mark-read"
      | "mark-unread";
    session: ChatHistorySession;
  }) => void | Promise<void>;
}

export function ChatHistoryRail({
  activeSessionId,
  isAuthenticated,
  isStreaming,
  workspaceId,
  requestHeaders,
  enabled = true,
  refreshSignal = 0,
  onSelectThread,
  onNewChat,
  beforeResetChatAfterArchiveAll,
  onArchiveAllComplete,
  onSessionAction,
}: ChatHistoryRailProps) {
  const [archivingAll, setArchivingAll] = useState(false);
  const { personal, workspace, loading, error, refetch, actions } =
    useChatHistory({
      workspaceId,
      enabled,
      requestHeaders,
    });

  const { activeMembers } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: workspaceId ?? null,
  });
  const ownerProfileByUserId = useMemo(
    () => buildWorkspaceOwnerProfileByUserId(activeMembers),
    [activeMembers],
  );

  const wasStreamingRef = useRef(isStreaming);
  const didMountRefreshRef = useRef(false);

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;

    const timeoutIds: ReturnType<typeof window.setTimeout>[] = [];

    if (wasStreaming && !isStreaming) {
      void refetch();
      for (const delayMs of HISTORY_REFETCH_RETRY_DELAYS_MS) {
        timeoutIds.push(
          window.setTimeout(() => {
            void refetch();
          }, delayMs),
        );
      }
    }

    return () => {
      for (const id of timeoutIds) {
        window.clearTimeout(id);
      }
    };
  }, [isStreaming, refetch]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!didMountRefreshRef.current) {
      didMountRefreshRef.current = true;
      return;
    }

    void refetch();
  }, [enabled, refetch, refreshSignal]);

  const activeThreadCount = personal.length + workspace.length;
  const canArchiveAll = activeThreadCount > 0 && !isStreaming && !archivingAll;

  const handleArchiveAll = async () => {
    if (!canArchiveAll) return;
    if (
      activeSessionId &&
      beforeResetChatAfterArchiveAll &&
      !beforeResetChatAfterArchiveAll()
    ) {
      return;
    }
    if (
      !window.confirm(
        `Archive all ${activeThreadCount} thread${activeThreadCount === 1 ? "" : "s"}?`,
      )
    ) {
      return;
    }
    setArchivingAll(true);
    try {
      await actions.archiveAllActive();
      onArchiveAllComplete?.(Boolean(activeSessionId));
    } finally {
      setArchivingAll(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-r">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
        <span className="text-xs font-medium text-foreground shrink-0">
          Threads
        </span>
        <div className="flex items-center gap-px shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-5 [&_svg]:size-3"
                aria-label="Archive all threads"
                onClick={() => void handleArchiveAll()}
                disabled={!canArchiveAll}
              >
                {archivingAll ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Archive className="size-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Archive all</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-5 [&_svg]:size-3"
                aria-label="New chat"
                onClick={onNewChat}
                disabled={isStreaming}
              >
                <Plus className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New chat</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-1 py-1">
          {loading && personal.length === 0 && workspace.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading &&
            error &&
            personal.length === 0 &&
            workspace.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 px-4 text-center">
                <p className="text-xs text-muted-foreground">
                  Could not load chat history.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              </div>
            )}

          {!loading &&
            !error &&
            personal.length === 0 &&
            workspace.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-8 px-4">
                No chat history yet. Start a conversation to see it here.
              </p>
            )}

          {/* Personal section */}
          {personal.length > 0 && (
            <div>
              {isAuthenticated && workspace.length > 0 && (
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">
                  Personal
                </p>
              )}
              {personal.map((session) => (
                <ChatHistoryRow
                  key={session._id}
                  session={session}
                  isActive={session._id === activeSessionId}
                  isAuthenticated={isAuthenticated}
                  isStreaming={isStreaming}
                  onSelect={onSelectThread}
                  onActionComplete={onSessionAction}
                  actions={actions}
                />
              ))}
            </div>
          )}

          {/* Workspace section */}
          {isAuthenticated && workspace.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-3 pb-1">
                Workspace
              </p>
              {workspace.map((session) => (
                <ChatHistoryRow
                  key={session._id}
                  session={session}
                  isActive={session._id === activeSessionId}
                  isAuthenticated={isAuthenticated}
                  isStreaming={isStreaming}
                  onSelect={onSelectThread}
                  onActionComplete={onSessionAction}
                  workspaceThreadOwner={resolveWorkspaceThreadOwnerAvatar(
                    session,
                    ownerProfileByUserId,
                  )}
                  actions={actions}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
