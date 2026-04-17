import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  compareThreadsForUsageList,
  threadMatchesUsageFilter,
  type UsageSessionFilter,
} from "@/hooks/chatbox-usage-filters";
import {
  useSharedChatThreadList,
  type SharedChatThread,
} from "@/hooks/useSharedChatThreads";

interface ShareUsageThreadListProps {
  sourceType: "chatbox" | "serverShare";
  sourceId: string;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** When set, filters and sorts threads for chatbox usage triage. */
  usageFilter?: UsageSessionFilter;
}

export function ShareUsageThreadList({
  sourceType,
  sourceId,
  selectedThreadId,
  onSelectThread,
  usageFilter = "all",
}: ShareUsageThreadListProps) {
  const { threads: rawThreads } = useSharedChatThreadList({
    sourceType,
    sourceId,
  });

  const threads = useMemo(() => {
    if (rawThreads === undefined) return undefined;
    const filtered =
      usageFilter === "all"
        ? rawThreads
        : rawThreads.filter((t) => threadMatchesUsageFilter(t, usageFilter));
    return [...filtered].sort(compareThreadsForUsageList);
  }, [rawThreads, usageFilter]);

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
            {usageFilter === "all"
              ? "No conversations yet"
              : "No sessions match this filter"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {usageFilter === "all"
              ? "Visitor conversations will appear here"
              : "Try another filter or check back later"}
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
  const rating = thread.feedbackRating;
  const needsReview =
    rating === 1 ||
    rating === 2 ||
    (rating === 3 && (thread.feedbackComment?.trim().length ?? 0) > 0);

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
        <p className="truncate text-sm font-medium">
          {thread.visitorDisplayName ?? "Anonymous"}
        </p>
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          {thread.toolCallCount ?? thread.messageCount}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {rating != null ? (
          <span
            className={`text-xs font-medium ${rating <= 2 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
          >
            {rating}/5
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No feedback</span>
        )}
        {needsReview ? (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
            <AlertTriangle className="size-3" />
            Needs review
          </span>
        ) : null}
      </div>
      {thread.firstMessagePreview ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {thread.firstMessagePreview}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground/70">
          {formatDistanceToNow(new Date(thread.lastActivityAt), {
            addSuffix: true,
          })}
        </span>
        {thread.modelId ? (
          <>
            <span className="text-[10px] text-muted-foreground/40">·</span>
            <span className="truncate font-mono text-[10px] text-muted-foreground/70">
              {thread.modelId}
            </span>
          </>
        ) : null}
      </div>
    </button>
  );
}
