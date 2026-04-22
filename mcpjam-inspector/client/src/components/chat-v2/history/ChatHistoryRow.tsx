import { useState, useRef, useEffect } from "react";
import { Pin, MoreVertical, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { Input } from "@mcpjam/design-system/input";
import { Avatar, AvatarFallback, AvatarImage } from "@mcpjam/design-system/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { getModelById } from "@/shared/types";
import { getInitials } from "@/lib/utils";
import type { WorkspaceThreadOwnerAvatar } from "./workspace-thread-owner-avatar";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import { CHAT_HISTORY_STRONG_BG_CLASS } from "./chat-history-theme";

function formatChatHistoryModelLabel(
  session: ChatHistorySession,
): string | null {
  const raw = session.modelId?.trim();
  if (!raw) return null;
  return getModelById(raw)?.name ?? raw;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60_000) return "now";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(diff / 86_400_000);
  if (days >= 7 && days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;

  return `${Math.floor(months / 12)}y`;
}

interface ChatHistoryRowProps {
  session: ChatHistorySession;
  isActive: boolean;
  isAuthenticated: boolean;
  isStreaming: boolean;
  /** Which host aesthetic governs the active-row highlight (defaults to "claude"). */
  hostStyle?: ChatboxHostStyle;
  onSelect: (session: ChatHistorySession) => void;
  onActionComplete?: (event: {
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
  canConvertToTestCase?: boolean;
  onConvertToTestCase?: (session: ChatHistorySession) => void;
  /** Workspace list only: avatar for another member's shared thread. */
  workspaceThreadOwner?: WorkspaceThreadOwnerAvatar;
  actions: {
    rename: (sessionId: string, customTitle: string) => Promise<void>;
    archive: (sessionId: string) => Promise<void>;
    unarchive: (sessionId: string) => Promise<void>;
    share: (sessionId: string) => Promise<void>;
    unshare: (sessionId: string) => Promise<void>;
    pin: (sessionId: string) => Promise<void>;
    unpin: (sessionId: string) => Promise<void>;
  };
}

export function ChatHistoryRow({
  session,
  isActive,
  isAuthenticated,
  isStreaming,
  hostStyle = "claude",
  onSelect,
  onActionComplete,
  canConvertToTestCase = false,
  onConvertToTestCase,
  workspaceThreadOwner,
  actions,
}: ChatHistoryRowProps) {
  const [relativeTime, setRelativeTime] = useState(
    formatRelativeTime(session.lastActivityAt),
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Refresh relative time every 60s
  useEffect(() => {
    const timer = setInterval(() => {
      setRelativeTime(formatRelativeTime(session.lastActivityAt));
    }, 60_000);
    return () => clearInterval(timer);
  }, [session.lastActivityAt]);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const title =
    session.customTitle ||
    session.firstMessagePreview.slice(0, 60) ||
    "Untitled chat";

  const modelLabel = formatChatHistoryModelLabel(session);

  const ownerAvatarTooltip =
    workspaceThreadOwner?.status === "show"
      ? workspaceThreadOwner.displayName
      : workspaceThreadOwner?.status === "generic"
        ? "Workspace member"
        : null;

  const hasWorkspaceOwner = workspaceThreadOwner != null;

  const ownerAvatar =
    workspaceThreadOwner != null ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex size-4 shrink-0 cursor-default items-center justify-center p-0 leading-none"
            data-testid="chat-history-owner-avatar"
          >
            <Avatar className="size-4 border border-border/50">
              {workspaceThreadOwner.status === "show" ? (
                <>
                  <AvatarImage
                    src={workspaceThreadOwner.imageUrl}
                    alt={workspaceThreadOwner.displayName}
                  />
                  <AvatarFallback className="text-[8px] leading-none">
                    {getInitials(workspaceThreadOwner.displayName)}
                  </AvatarFallback>
                </>
              ) : (
                <AvatarFallback className="bg-muted">
                  <User className="size-2 text-muted-foreground" aria-hidden />
                </AvatarFallback>
              )}
            </Avatar>
          </div>
        </TooltipTrigger>
        {ownerAvatarTooltip ? (
          <TooltipContent side="right">{ownerAvatarTooltip}</TooltipContent>
        ) : null}
      </Tooltip>
    ) : null;

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (trimmed || session.customTitle) {
      await actions.rename(session._id, trimmed);
      await onActionComplete?.({ action: "rename", session });
    }
    setIsRenaming(false);
  };

  const runAction = async (
    action: "archive" | "unarchive" | "pin" | "unpin" | "share" | "unshare",
    operation: () => Promise<void>,
  ) => {
    await operation();
    await onActionComplete?.({ action, session });
  };

  const handleClick = () => {
    if (isStreaming || isRenaming) return;
    onSelect(session);
  };

  if (isRenaming) {
    const renameField = (
      <div className="min-w-0 flex-1 py-1.5 pl-0 pr-2">
        <Input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRenameSubmit();
            if (e.key === "Escape") setIsRenaming(false);
          }}
          onBlur={handleRenameSubmit}
          className="h-7 text-xs"
        />
      </div>
    );

    return hasWorkspaceOwner ? (
      <div className="flex w-full max-w-full min-w-0 items-center gap-1">
        <div className="flex size-4 shrink-0 items-center justify-center">
          {ownerAvatar}
        </div>
        {renameField}
      </div>
    ) : (
      renameField
    );
  }

  const rowMain = (
    <div
      className={`group relative flex min-w-0 w-full max-w-full items-center gap-1.5 overflow-hidden rounded-md py-1.5 pl-0 pr-2 text-xs cursor-pointer transition-colors has-[[data-slot=dropdown-menu-trigger][data-state=open]]:[&_.chat-history-time]:opacity-0 has-[[data-slot=dropdown-menu-trigger]:focus-visible]:[&_.chat-history-time]:opacity-0 ${
        isActive ? CHAT_HISTORY_STRONG_BG_CLASS[hostStyle] : "hover:bg-accent/50"
      } ${isStreaming ? "opacity-50 cursor-not-allowed" : ""}`}
      onClick={handleClick}
    >
      {hasWorkspaceOwner ? (
        session.isPinned ? (
          <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
            <span className="opacity-100 transition-opacity duration-150 group-hover:pointer-events-none group-hover:opacity-0 group-focus-within:pointer-events-none group-focus-within:opacity-0">
              {ownerAvatar}
            </span>
            <span
              className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label="Pinned"
              title="Pinned"
            >
              <Pin className="h-3 w-3 rotate-45" strokeWidth={2} aria-hidden />
            </span>
          </span>
        ) : (
          <span className="inline-flex size-4 shrink-0 items-center justify-center">
            {ownerAvatar}
          </span>
        )
      ) : (
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
          aria-hidden={!session.isPinned}
          title={session.isPinned ? "Pinned" : undefined}
          {...(session.isPinned ? { "aria-label": "Pinned" as const } : {})}
        >
          {session.isPinned ? (
            <Pin className="h-3 w-3 rotate-45" strokeWidth={2} aria-hidden />
          ) : null}
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <span
          className="min-w-0 flex-[7_1_0%] truncate font-medium"
          title={title}
        >
          {title}
        </span>
        {modelLabel ? (
          <span
            className="min-w-0 flex-[3_1_0%] truncate text-[10px] text-muted-foreground"
            data-testid="chat-history-model"
            title={modelLabel}
          >
            {modelLabel}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <div className="relative flex h-4 w-8 shrink-0 items-center justify-end tabular-nums [@media(pointer:coarse)]:w-auto [@media(pointer:coarse)]:gap-1">
          <span className="chat-history-time pointer-events-none text-[10px] text-muted-foreground transition-opacity [@media(pointer:fine)]:absolute [@media(pointer:fine)]:inset-y-0 [@media(pointer:fine)]:right-0 [@media(pointer:fine)]:flex [@media(pointer:fine)]:items-center [@media(pointer:fine)]:justify-end [@media(pointer:fine)]:group-hover:opacity-0">
            {relativeTime}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={isStreaming}
              className="flex items-center justify-end rounded p-0.5 outline-none transition-opacity hover:bg-accent data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(pointer:fine)]:pointer-events-none [@media(pointer:fine)]:absolute [@media(pointer:fine)]:inset-y-0 [@media(pointer:fine)]:right-0 [@media(pointer:fine)]:z-10 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:pointer-events-auto [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onClick={() => {
                  setRenameValue(session.customTitle || "");
                  setIsRenaming(true);
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () =>
                  session.isPinned
                    ? await runAction("unpin", () => actions.unpin(session._id))
                    : await runAction("pin", () => actions.pin(session._id))
                }
              >
                {session.isPinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>

              {isAuthenticated && (
                <>
                  <DropdownMenuSeparator />
                  {canConvertToTestCase && onConvertToTestCase ? (
                    <>
                      <DropdownMenuItem
                        onClick={() => onConvertToTestCase(session)}
                      >
                        Convert to test case
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuItem
                    onClick={async () =>
                      session.directVisibility === "workspace"
                        ? await runAction("unshare", () =>
                            actions.unshare(session._id),
                          )
                        : await runAction("share", () =>
                            actions.share(session._id),
                          )
                    }
                  >
                    {session.directVisibility === "workspace"
                      ? "Unshare"
                      : "Share to workspace"}
                  </DropdownMenuItem>
                </>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () =>
                  session.status === "active"
                    ? await runAction("archive", () =>
                        actions.archive(session._id),
                      )
                    : await runAction("unarchive", () =>
                        actions.unarchive(session._id),
                      )
                }
              >
                {session.status === "active" ? "Archive" : "Unarchive"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );

  return rowMain;
}
