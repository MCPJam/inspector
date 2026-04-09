import { useState, useRef, useEffect } from "react";
import { Pin, MoreVertical, Circle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60_000) return "now";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(diff / 86_400_000);
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
  onSelect: (session: ChatHistorySession) => void;
  onActionComplete?: (event: {
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
  };
}

export function ChatHistoryRow({
  session,
  isActive,
  isAuthenticated,
  isStreaming,
  onSelect,
  onActionComplete,
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

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (trimmed || session.customTitle) {
      await actions.rename(session._id, trimmed);
      await onActionComplete?.({ action: "rename", session });
    }
    setIsRenaming(false);
  };

  const runAction = async (
    action:
      | "archive"
      | "unarchive"
      | "share"
      | "unshare"
      | "pin"
      | "unpin"
      | "mark-read"
      | "mark-unread",
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
    return (
      <div className="px-2 py-1.5">
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
  }

  return (
    <div
        className={`group relative flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs cursor-pointer transition-colors has-[[data-slot=dropdown-menu-trigger][data-state=open]]:[&_.chat-history-time]:opacity-0 has-[[data-slot=dropdown-menu-trigger]:focus-visible]:[&_.chat-history-time]:opacity-0 ${
          isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
        } ${isStreaming ? "opacity-50 cursor-not-allowed" : ""}`}
        onClick={handleClick}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            {session.isUnread && (
              <Circle className="h-1.5 w-1.5 fill-primary text-primary shrink-0" />
            )}
            <span className="font-medium truncate">{title}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {session.isPinned && (
            <Pin className="h-3 w-3 text-muted-foreground" />
          )}
          <div
            className="relative flex h-4 w-8 shrink-0 items-center justify-end tabular-nums [@media(pointer:coarse)]:w-auto [@media(pointer:coarse)]:gap-1"
          >
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
              <DropdownMenuItem
                onClick={async () =>
                  session.isUnread
                    ? await runAction("mark-read", () =>
                        actions.markRead(session._id),
                      )
                    : await runAction("mark-unread", () =>
                        actions.markUnread(session._id),
                      )
                }
              >
                {session.isUnread ? "Mark read" : "Mark unread"}
              </DropdownMenuItem>

              {isAuthenticated && (
                <>
                  <DropdownMenuSeparator />
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
}
