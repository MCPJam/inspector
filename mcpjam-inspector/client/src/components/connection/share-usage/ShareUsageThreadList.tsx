import { AlertTriangle, MessageSquare } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  compareThreadsForUsageList,
  threadMatchesFilterState,
  threadMatchesUsageFilter,
  type UsageFilterState,
  type UsageSessionFilter,
} from "@/hooks/scenario-usage-filters";
import {
  useSharedChatThreadList,
  type SharedChatThread,
} from "@/hooks/useSharedChatThreads";
import { SessionReadinessBadge } from "@/components/scenarios/session-readiness";
import { SessionGoalScoreBadge } from "@/components/shared/session-quality/session-goal-score-badge";
import { SessionFeedbackMark } from "@/components/connection/share-usage/session-feedback-mark";
import { formatCompactRelativeTime } from "@/components/connection/share-usage/session-list-format";
import { cn } from "@/lib/utils";

interface ShareUsageThreadListProps {
  /** Optional: when `threads` is provided (scenario Usage panel) these are unused. */
  sourceType?: "scenario";
  sourceId?: string;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** Legacy preset-only filter, for non-scenario callers (ShareUsageDialog). */
  usageFilter?: UsageSessionFilter;
  /**
   * Preferred: pre-filtered, pre-sorted threads from the panel. When provided,
   * this list is rendered verbatim and the legacy hook call is skipped.
   */
  threads?: SharedChatThread[] | undefined;
  /**
   * Richer filter state used by the scenario Usage panel for empty-state copy
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
      : { sourceType: sourceType ?? "scenario", sourceId: null }
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
      <div className="flex flex-col">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex h-14 items-center gap-2 border-l-2 border-transparent px-3"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
            </div>
            <div className="h-3 w-8 animate-pulse rounded bg-muted" />
            <div className="h-3 w-6 animate-pulse rounded bg-muted" />
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
      <div>
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

/** List-pane chrome: count + filter pills, matching the Sessions redesign. */
export function SessionListChrome({
  countLabel,
  children,
}: {
  countLabel: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="shrink-0">
      <div className="px-3 pt-2 pb-1.5">
        <div className="text-sm font-semibold leading-5 text-card-foreground">
          {countLabel}
        </div>
      </div>
      {children ? (
        <div className="flex min-h-9 items-center gap-1.5 border-b border-border px-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadCard({
  thread,
  isSelected,
  onSelect,
}: {
  thread: SharedChatThread;
  isSelected: boolean;
  onSelect: () => void;
}) {
  // The session's rating is its WORST turn (see `scenario-usage-filters.ts`),
  // so the amber treatment fires on "one turn went badly", not "the average
  // was low" — which is the cohort a PM opens this list to find.
  const summary = thread.feedback ?? null;
  const rating = summary?.min ?? thread.feedbackRating ?? null;
  const hasComment =
    summary?.hasComment ?? (thread.feedbackComment?.trim().length ?? 0) > 0;
  const needsReview =
    (rating != null && rating <= 2) || (rating === 3 && hasComment);
  const preview = thread.firstMessagePreview?.trim() || thread.themeClusterLabel;
  const title = thread.visitorDisplayName ?? "Anonymous";

  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={isSelected ? "true" : "false"}
      className={cn(
        "flex min-h-14 w-full items-center gap-2 self-stretch border-l-2 px-3 text-left transition-colors",
        isSelected
          ? "border-l-primary bg-muted"
          : "border-l-transparent hover:bg-muted/50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold leading-5 text-card-foreground">
          <span className="truncate">{title}</span>
          {thread.synthetic === true ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
              aria-label="Synthetic session"
              role="img"
            />
          ) : null}
          {thread.readiness ? (
            <SessionReadinessBadge readiness={thread.readiness} />
          ) : null}
          {thread.surface === "preview" ? (
            <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
              Preview
            </span>
          ) : null}
        </p>
        {preview ? (
          <p className="truncate text-xs text-muted-foreground">{preview}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <SessionFeedbackMark thread={thread} />
        {needsReview ? (
          <AlertTriangle
            className="size-3 text-amber-600 dark:text-amber-400"
            aria-label="Needs review"
          />
        ) : null}
        <SessionGoalScoreBadge goalScore={thread.goalScore} />
      </div>
      <span className="w-7 shrink-0 text-right text-[10px] leading-none text-muted-foreground">
        {formatCompactRelativeTime(thread.lastActivityAt)}
      </span>
    </button>
  );
}
