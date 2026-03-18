import { formatDistanceToNow } from "date-fns";
import { MessageSquare } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useSharedChatThreadList,
  type SharedChatSourceType,
  type SharedChatThread,
} from "@/hooks/useSharedChatThreads";

interface ShareUsageThreadListProps {
  sourceType: SharedChatSourceType;
  sourceId: string;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
}

export function ShareUsageThreadList({
  sourceType,
  sourceId,
  selectedThreadId,
  onSelectThread,
}: ShareUsageThreadListProps) {
  const { threads } = useSharedChatThreadList({ sourceType, sourceId });

  if (threads === undefined) {
    return (
      <div className="space-y-3 p-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-3">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">
            No conversations yet
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Visitor conversations will appear here
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-2">
        {threads.map((thread) => (
          <ThreadCard
            key={thread._id}
            thread={thread}
            isSelected={thread._id === selectedThreadId}
            onSelect={() => onSelectThread(thread._id)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function ThreadCard({
  thread,
  isSelected,
  onSelect,
}: {
  thread: SharedChatThread;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        isSelected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:bg-muted/50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium truncate">
          {thread.visitorDisplayName}
        </p>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          {thread.messageCount}
        </span>
      </div>
      {thread.firstMessagePreview && (
        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
          {thread.firstMessagePreview}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground/70">
          {formatDistanceToNow(new Date(thread.lastActivityAt), {
            addSuffix: true,
          })}
        </span>
        {thread.modelId && (
          <>
            <span className="text-[10px] text-muted-foreground/40">·</span>
            <span className="text-[10px] text-muted-foreground/70 truncate">
              {thread.modelId}
            </span>
          </>
        )}
      </div>
    </button>
  );
}
