import { useState, useRef, useEffect } from "react";
import { Pin, MoreVertical, Save, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { Input } from "@mcpjam/design-system/input";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import { getModelById } from "@/shared/types";
import { getInitials } from "@/lib/utils";
import type { ProjectThreadOwnerAvatar } from "./project-thread-owner-avatar";
import {
  getScenarioHostFamily,
  type ScenarioHostStyle,
} from "@/lib/scenario-client-style";
import { CHAT_HISTORY_STRONG_BG_CLASS } from "./chat-history-theme";
import { sessionEffortSuffix } from "@/components/connection/share-usage/session-client-model";
import {
  showSessionActionFailure,
  showSessionActionSuccess,
  type SessionRowAction,
} from "./session-action-feedback";

export function formatChatHistoryModelLabel(
  session: ChatHistorySession,
  /** Names for models the static list does not know, e.g. hosted ones. */
  modelName?: (modelId: string) => string | undefined,
): string | null {
  const raw = session.modelId?.trim();
  if (!raw) return null;
  // Plus the effort the session's last turn ran at (" · High").
  return `${modelName?.(raw) ?? getModelById(raw)?.name ?? raw}${sessionEffortSuffix(
    session.modelSelection,
  )}`;
}

const ROW_ICON_BUTTON_CLASS =
  "flex size-5 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 disabled:pointer-events-none disabled:opacity-50";

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
  sharedThreadsEnabled?: boolean;
  /** Which host aesthetic governs the active-row highlight (defaults to "claude"). */
  hostStyle?: ScenarioHostStyle;
  onSelect: (session: ChatHistorySession) => void;
  /** Fired on pointer-enter so callers can warm caches for the click path. */
  onPrefetch?: (session: ChatHistorySession) => void;
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
  /** Project list only: avatar for another member's shared thread. */
  projectThreadOwner?: ProjectThreadOwnerAvatar;
  /** Replaces the title, e.g. a column row named by its model. */
  titleOverride?: string;
  /** Replaces the model label, e.g. a multi-model session's lineup. */
  labelOverride?: string;
  /** Multi-model sessions are not shared to a project. */
  hideShare?: boolean;
  /** Overrides "Archive" for rows that archive more than one chat. */
  archiveLabel?: string;
  /** A row that only opens its chat, e.g. a column of a multi-model session. */
  hideMenu?: boolean;
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
  sharedThreadsEnabled = true,
  hostStyle = "claude",
  onSelect,
  onPrefetch,
  onActionComplete,
  canConvertToTestCase = false,
  onConvertToTestCase,
  projectThreadOwner,
  titleOverride,
  labelOverride,
  hideShare = false,
  archiveLabel = "Archive",
  hideMenu = false,
  actions,
}: ChatHistoryRowProps) {
  const [relativeTime, setRelativeTime] = useState(
    formatRelativeTime(session.lastActivityAt),
  );
  const hostStyleFamily = getScenarioHostFamily(hostStyle) ?? "claude";
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
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
    titleOverride ||
    session.customTitle ||
    session.firstMessagePreview.slice(0, 60) ||
    "Untitled chat";

  const modelLabel = labelOverride ?? formatChatHistoryModelLabel(session);

  const ownerAvatarTooltip =
    projectThreadOwner?.status === "show"
      ? projectThreadOwner.displayName
      : projectThreadOwner?.status === "generic"
        ? "Project member"
        : null;

  const hasProjectOwner = projectThreadOwner != null;

  const ownerAvatar =
    projectThreadOwner != null ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex size-4 shrink-0 cursor-default items-center justify-center p-0 leading-none"
            data-testid="chat-history-owner-avatar"
          >
            <Avatar className="size-4 border border-border/50">
              {projectThreadOwner.status === "show" ? (
                <>
                  <AvatarImage
                    src={projectThreadOwner.imageUrl}
                    alt={projectThreadOwner.displayName}
                  />
                  <AvatarFallback className="text-[8px] leading-none">
                    {getInitials(projectThreadOwner.displayName)}
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
    action: SessionRowAction,
    operation: () => Promise<void>,
  ) => {
    try {
      await operation();
    } catch (error) {
      showSessionActionFailure(action, error);
      return;
    }
    await onActionComplete?.({ action, session });
    showSessionActionSuccess(action, {
      undoArchive: async () => {
        await actions.unarchive(session._id);
        await onActionComplete?.({ action: "unarchive", session });
      },
    });
  };

  const handleClick = () => {
    if (isStreaming || isRenaming) return;
    onSelect(session);
  };
  const handlePointerEnter = () => {
    if (isStreaming || isActive || isRenaming) return;
    onPrefetch?.(session);
  };
  const canManageProjectSharing =
    isAuthenticated && sharedThreadsEnabled && !hideShare;

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

    return hasProjectOwner ? (
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
      className={`group relative flex min-w-0 w-full max-w-full items-center gap-1.5 overflow-hidden rounded-md py-1.5 pl-0 pr-2 text-xs cursor-pointer transition-colors ${
        isActive
          ? CHAT_HISTORY_STRONG_BG_CLASS[hostStyleFamily]
          : "hover:bg-accent/50"
      } ${isStreaming ? "opacity-50 cursor-not-allowed" : ""}`}
      onClick={handleClick}
      onPointerEnter={handlePointerEnter}
      onContextMenu={(e) => {
        if (isStreaming || isRenaming) return;
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      {hasProjectOwner ? (
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
        {canConvertToTestCase && onConvertToTestCase ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <button
                  type="button"
                  data-testid="chat-history-promote-to-test-case"
                  disabled={isStreaming}
                  aria-label="Save as test case"
                  className={ROW_ICON_BUTTON_CLASS}
                  onClick={(e) => {
                    e.stopPropagation();
                    onConvertToTestCase(session);
                  }}
                >
                  <Save className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Save as test case</TooltipContent>
          </Tooltip>
        ) : null}
        <span className="chat-history-time w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
          {relativeTime}
        </span>
        {hideMenu ? null : (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              disabled={isStreaming}
              aria-label="Session actions"
              className={ROW_ICON_BUTTON_CLASS}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-3.5 w-3.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-52"
              onClick={(e) => e.stopPropagation()}
            >
              {canConvertToTestCase && onConvertToTestCase ? (
                <>
                  <DropdownMenuItem
                    onClick={() => onConvertToTestCase(session)}
                  >
                    Save as test case
                  </DropdownMenuItem>
                </>
              ) : null}
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

              {canManageProjectSharing && (
                <>
                  <DropdownMenuItem
                    onClick={async () =>
                      session.directVisibility === "project"
                        ? await runAction("unshare", () =>
                            actions.unshare(session._id),
                          )
                        : await runAction("share", () =>
                            actions.share(session._id),
                          )
                    }
                  >
                    {session.directVisibility === "project"
                      ? "Unshare"
                      : "Add to Shared Sessions"}
                  </DropdownMenuItem>
                </>
              )}

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
                {session.status === "active" ? archiveLabel : "Unarchive"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );

  return rowMain;
}
