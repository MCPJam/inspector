import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, Folder, FolderOpen, Loader2, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { ChatHistoryRow } from "./ChatHistoryRow";
import { useChatHistory } from "./use-chat-history";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import {
  buildWorkspaceOwnerProfileByUserId,
  resolveWorkspaceThreadOwnerAvatar,
} from "./workspace-thread-owner-avatar";

/** Delays (ms) after a turn completes to re-fetch list while backend ingestion may still be running. */
const HISTORY_REFETCH_RETRY_DELAYS_MS = [250, 800, 2000] as const;

type ArchiveSectionScope = "personal" | "workspace";

interface ChatHistoryRailProps {
  activeSessionId?: string | null;
  /** Which host aesthetic to mimic for strong-highlight tokens (falls back to "claude"). */
  hostStyle?: ChatboxHostStyle;
  isAuthenticated: boolean;
  isStreaming: boolean;
  workspaceId?: string | null;
  requestHeaders?: HeadersInit;
  enabled?: boolean;
  refreshSignal?: number;
  onSelectThread: (session: ChatHistorySession) => void;
  onNewChat: (options?: { shared?: boolean }) => void;
  /** If the user has an active thread selected, run before archiving all (e.g. draft-confirm modal). */
  beforeResetChatAfterArchiveAll?: () => boolean | Promise<boolean>;
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
      | "unpin";
    session: ChatHistorySession;
  }) => void | Promise<void>;
}

function ThreadSection({
  headingId,
  title,
  triggerLabel,
  archiveAriaLabel,
  newChatAriaLabel,
  archiveTooltip,
  canArchive,
  archiving,
  onArchive,
  onNewChat,
  newChatDisabled,
  defaultOpen = true,
  children,
}: {
  headingId: string;
  title: string;
  /** Accessible name for the section header row (collapse/expand). */
  triggerLabel: string;
  archiveAriaLabel: string;
  newChatAriaLabel: string;
  archiveTooltip: string;
  canArchive: boolean;
  archiving: boolean;
  onArchive: () => void;
  onNewChat: (options?: { shared?: boolean }) => void;
  newChatDisabled: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section aria-labelledby={headingId}>
        <div
          className={cn(
            "sticky top-0 z-10 bg-background/95 supports-[backdrop-filter]:backdrop-blur-sm",
          )}
        >
          <CollapsibleTrigger asChild>
            <div
              role="button"
              tabIndex={0}
              aria-label={triggerLabel}
              className={cn(
                "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs outline-none transition-[background-color,color] duration-150 ease-out",
                "text-muted-foreground no-underline hover:bg-accent/60",
                "focus-visible:ring-2 focus-visible:ring-ring/40",
              )}
            >
              {open ? (
                <FolderOpen
                  className="size-3.5 shrink-0 stroke-[1.25] text-muted-foreground"
                  aria-hidden
                />
              ) : (
                <Folder
                  className="size-3.5 shrink-0 stroke-[1.25] text-muted-foreground"
                  aria-hidden
                />
              )}
              <h2
                id={headingId}
                className="min-w-0 flex-1 truncate font-medium text-foreground/85"
              >
                {title}
              </h2>
              <div
                className="flex shrink-0 items-center gap-px"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-5 no-underline [&_svg]:size-3"
                      aria-label={archiveAriaLabel}
                      onClick={() => void onArchive()}
                      disabled={!canArchive}
                    >
                      {archiving ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Archive className="size-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {archiveTooltip}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-5 no-underline [&_svg]:size-3"
                      aria-label={newChatAriaLabel}
                      onClick={() => onNewChat()}
                      disabled={newChatDisabled}
                    >
                      <Plus className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">New chat</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent
          className={cn(
            // Explicit column + min-w-0 so thread rows cannot widen the grid past the rail
            // (implicit grid tracks default to max-content and break truncation).
            "grid min-w-0 grid-cols-1 overflow-hidden transition-[grid-template-rows] duration-200 ease-out",
            "data-[state=closed]:grid-rows-[0fr]",
            "data-[state=open]:grid-rows-[1fr]",
          )}
        >
          <div className="min-h-0 min-w-0 overflow-x-hidden">
            <div className="min-w-0 space-y-0.5 py-0.5 pl-1.5">{children}</div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function ChatHistoryRail({
  activeSessionId,
  hostStyle = "claude",
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
  const [archivingScope, setArchivingScope] =
    useState<ArchiveSectionScope | null>(null);
  const { personal, workspace, loading, error, isReactive, refetch, actions } =
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

    if (wasStreaming && !isStreaming && !isReactive) {
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
  }, [isStreaming, isReactive, refetch]);

  useEffect(() => {
    if (!enabled || isReactive) {
      return;
    }

    if (!didMountRefreshRef.current) {
      didMountRefreshRef.current = true;
      return;
    }

    void refetch();
  }, [enabled, isReactive, refetch, refreshSignal]);

  const archiveBusy = archivingScope !== null;

  const handleArchiveSection = async (
    scope: ArchiveSectionScope,
    sessions: ChatHistorySession[],
  ) => {
    const count = sessions.length;
    const canStart = count > 0 && !isStreaming && !archiveBusy;
    if (!canStart) return;

    const activeInSection = sessions.some((s) => s._id === activeSessionId);
    if (activeInSection && beforeResetChatAfterArchiveAll) {
      const allowed = await Promise.resolve(beforeResetChatAfterArchiveAll());
      if (!allowed) {
        return;
      }
    }
    setArchivingScope(scope);
    try {
      await actions.archiveManySessionIds(sessions.map((s) => s._id));
      onArchiveAllComplete?.(activeInSection);
    } finally {
      setArchivingScope(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col border-r">
      <ScrollArea
        className={cn(
          "min-h-0 min-w-0 flex-1",
          // Scrollbar: scoped polish — narrower, softer thumb, subtle hover expand.
          "[&_[data-slot=scroll-area-scrollbar]]:z-20",
          "[&_[data-slot=scroll-area-scrollbar]]:w-1.5",
          "[&_[data-slot=scroll-area-scrollbar]]:transition-[width,background-color]",
          "[&_[data-slot=scroll-area-scrollbar]]:duration-150",
          "hover:[&_[data-slot=scroll-area-scrollbar]]:w-2",
          "[&_[data-slot=scroll-area-thumb]]:bg-muted-foreground/30",
          "[&_[data-slot=scroll-area-thumb]]:transition-colors",
          "[&_[data-slot=scroll-area-thumb]]:duration-150",
          "hover:[&_[data-slot=scroll-area-thumb]]:bg-muted-foreground/60",
        )}
      >
        <div className="min-w-0 px-1 py-1">
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

          {enabled && !loading && !error && (
            <>
              <div className={isAuthenticated ? "mb-1" : undefined}>
                <ThreadSection
                  headingId="chat-history-my-threads-heading"
                  title="My Threads"
                  triggerLabel="My threads section"
                  archiveAriaLabel="Archive all threads in My Threads"
                  newChatAriaLabel="New chat in My Threads"
                  archiveTooltip="Archive all in My Threads"
                  canArchive={
                    personal.length > 0 && !isStreaming && !archiveBusy
                  }
                  archiving={archivingScope === "personal"}
                  onArchive={() =>
                    void handleArchiveSection("personal", personal)
                  }
                  onNewChat={onNewChat}
                  newChatDisabled={isStreaming}
                >
                  {personal.map((session) => (
                    <ChatHistoryRow
                      key={session._id}
                      session={session}
                      isActive={session._id === activeSessionId}
                      isAuthenticated={isAuthenticated}
                      isStreaming={isStreaming}
                      hostStyle={hostStyle}
                      onSelect={onSelectThread}
                      onActionComplete={onSessionAction}
                      actions={actions}
                    />
                  ))}
                </ThreadSection>
              </div>

              {isAuthenticated ? (
                <ThreadSection
                  headingId="chat-history-shared-threads-heading"
                  title="Shared Threads"
                  triggerLabel="Shared threads section"
                  archiveAriaLabel="Archive all threads in Shared Threads"
                  newChatAriaLabel="New chat in Shared Threads"
                  archiveTooltip="Archive all in Shared Threads"
                  canArchive={
                    workspace.length > 0 && !isStreaming && !archiveBusy
                  }
                  archiving={archivingScope === "workspace"}
                  onArchive={() =>
                    void handleArchiveSection("workspace", workspace)
                  }
                  onNewChat={() => onNewChat({ shared: true })}
                  newChatDisabled={isStreaming}
                >
                  {workspace.map((session) => (
                    <ChatHistoryRow
                      key={session._id}
                      session={session}
                      isActive={session._id === activeSessionId}
                      isAuthenticated={isAuthenticated}
                      isStreaming={isStreaming}
                      hostStyle={hostStyle}
                      onSelect={onSelectThread}
                      onActionComplete={onSessionAction}
                      workspaceThreadOwner={resolveWorkspaceThreadOwnerAvatar(
                        session,
                        ownerProfileByUserId,
                      )}
                      actions={actions}
                    />
                  ))}
                </ThreadSection>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
