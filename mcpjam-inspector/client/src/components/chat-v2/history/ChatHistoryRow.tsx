import { useState, useRef, useEffect } from "react";
import { Pin, MoreVertical, Circle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

export function ChatHistoryRow({
  session,
  isActive,
  isAuthenticated,
  isStreaming,
  onSelect,
  actions,
}: ChatHistoryRowProps) {
  const [relativeTime, setRelativeTime] = useState(
    formatRelativeTime(session.lastActivityAt),
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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
    if (trimmed) {
      await actions.rename(session._id, trimmed);
    }
    setIsRenaming(false);
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
    <>
      <div
        className={`group flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs cursor-pointer transition-colors ${
          isActive
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/50"
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
          <div className="flex items-center gap-1 mt-0.5 text-muted-foreground">
            <span className="truncate text-[10px]">
              {session.firstMessagePreview.slice(0, 50)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {session.isPinned && (
            <Pin className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="text-[10px] text-muted-foreground">
            {relativeTime}
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent"
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
                onClick={() =>
                  session.isPinned
                    ? actions.unpin(session._id)
                    : actions.pin(session._id)
                }
              >
                {session.isPinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  session.isUnread
                    ? actions.markRead(session._id)
                    : actions.markUnread(session._id)
                }
              >
                {session.isUnread ? "Mark read" : "Mark unread"}
              </DropdownMenuItem>

              {isAuthenticated && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      session.directVisibility === "workspace"
                        ? actions.unshare(session._id)
                        : actions.share(session._id)
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
                onClick={() =>
                  session.status === "active"
                    ? actions.archive(session._id)
                    : actions.unarchive(session._id)
                }
              >
                {session.status === "active" ? "Archive" : "Unarchive"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this chat and its transcript. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => actions.deleteSession(session._id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
