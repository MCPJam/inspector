import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatHistoryRow } from "./ChatHistoryRow";
import { useChatHistory } from "./use-chat-history";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";

interface ChatHistoryRailProps {
  activeThreadId: string;
  isAuthenticated: boolean;
  isStreaming: boolean;
  workspaceId?: string | null;
  onSelectThread: (session: ChatHistorySession) => void;
  onNewChat: () => void;
}

export function ChatHistoryRail({
  activeThreadId,
  isAuthenticated,
  isStreaming,
  workspaceId,
  onSelectThread,
  onNewChat,
}: ChatHistoryRailProps) {
  const {
    personal,
    workspace,
    loading,
    activeStatus,
    setActiveStatus,
    actions,
  } = useChatHistory({
    workspaceId,
    enabled: true,
  });

  return (
    <div className="flex flex-col h-full border-r">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-semibold">History</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onNewChat}
          disabled={isStreaming}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Active / Archived toggle */}
      <div className="flex px-2 pt-2 pb-1 gap-1">
        <button
          className={`flex-1 text-xs py-1 px-2 rounded-md font-medium transition-colors ${
            activeStatus === "active"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50"
          }`}
          onClick={() => setActiveStatus("active")}
        >
          Active
        </button>
        <button
          className={`flex-1 text-xs py-1 px-2 rounded-md font-medium transition-colors ${
            activeStatus === "archived"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50"
          }`}
          onClick={() => setActiveStatus("archived")}
        >
          Archived
        </button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="px-1 py-1">
          {loading && personal.length === 0 && workspace.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading &&
            personal.length === 0 &&
            workspace.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-8 px-4">
                {activeStatus === "active"
                  ? "No chat history yet. Start a conversation to see it here."
                  : "No archived chats."}
              </p>
            )}

          {/* Personal section */}
          {personal.length > 0 && (
            <div>
              {(isAuthenticated && workspace.length > 0) && (
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">
                  Personal
                </p>
              )}
              {personal.map((session) => (
                <ChatHistoryRow
                  key={session._id}
                  session={session}
                  isActive={session.chatSessionId === activeThreadId}
                  isAuthenticated={isAuthenticated}
                  isStreaming={isStreaming}
                  onSelect={onSelectThread}
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
                  isActive={session.chatSessionId === activeThreadId}
                  isAuthenticated={isAuthenticated}
                  isStreaming={isStreaming}
                  onSelect={onSelectThread}
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
