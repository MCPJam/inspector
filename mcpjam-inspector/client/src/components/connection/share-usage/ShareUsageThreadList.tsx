import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, MessageSquare, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  compareThreadsForUsageList,
  threadMatchesFilterState,
  threadMatchesUsageFilter,
  type UsageFilterState,
  type UsageSessionFilter,
} from "@/hooks/chatbox-usage-filters";
import {
  useSharedChatThreadList,
  type SharedChatThread,
} from "@/hooks/useSharedChatThreads";

interface ShareUsageThreadListProps {
  /** Optional: when `threads` is provided (chatbox Usage panel) these are unused. */
  sourceType?: "chatbox" | "serverShare";
  sourceId?: string;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** Legacy preset-only filter, for non-chatbox callers (ShareUsageDialog). */
  usageFilter?: UsageSessionFilter;
  /**
   * Preferred: pre-filtered, pre-sorted threads from the panel. When provided,
   * this list is rendered verbatim and the legacy hook call is skipped.
   */
  threads?: SharedChatThread[] | undefined;
  /**
   * Richer filter state used by the chatbox Usage panel for empty-state copy
   * and, on the legacy internal-fetch path, to apply chip filters as well.
   */
  filterState?: UsageFilterState;
}

export function ShareUsageThreadList({
  sourceType,
  sourceId,
  selectedThreadId,
  onSelectThread,
  usageFilter = "all",
  threads: providedThreads,
  filterState,
}: ShareUsageThreadListProps) {
  const legacyThreads = useSharedChatThreadList(
    providedThreads === undefined && sourceType && sourceId
      ? { sourceType, sourceId }
      : { sourceType: sourceType ?? "chatbox", sourceId: null },
  );

  const threads = useMemo(() => {
    if (providedThreads !== undefined) return providedThreads;
    const raw = legacyThreads.threads;
    if (raw === undefined) return undefined;
    const filtered = filterState
      ? raw.filter((t) => threadMatchesFilterState(t, filterState))
      : usageFilter === "all"
        ? raw
        : raw.filter((t) => threadMatchesUsageFilter(t, usageFilter));
    return [...filtered].sort(compareThreadsForUsageList);
  }, [providedThreads, legacyThreads.threads, filterState, usageFilter]);

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

  const activePreset = filterState?.preset ?? usageFilter;
  const hasActiveChips = (filterState?.chips.length ?? 0) > 0;

  if (threads.length === 0) {
    const emptyMessage =
      activePreset !== "all" || hasActiveChips
        ? "No sessions match the current filters"
        : "No conversations yet";
    const emptyHint =
      activePreset !== "all" || hasActiveChips
        ? "Try removing a filter or clearing the chart chips"
        : "Visitor conversations will appear here";

    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">
            {emptyMessage}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">{emptyHint}</p>
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
        {thread.themeClusterLabel ? (
          <span className="inline-flex max-w-[120px] items-center gap-0.5 truncate rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <Sparkles className="size-2.5 shrink-0" />
            <span className="truncate">{thread.themeClusterLabel}</span>
          </span>
        ) : null}
        {thread.geoCountry ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {thread.geoCountry}
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
