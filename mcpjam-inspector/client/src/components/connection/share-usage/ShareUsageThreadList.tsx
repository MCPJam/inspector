import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, MessageSquare } from "lucide-react";
import { useMemo } from "react";
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
import {
  feedbackHeadline,
  formatThumbCounts,
} from "@/components/connection/share-usage/feedback-headline";

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
  const ratingCount = summary?.count ?? thread.feedbackCount ?? 0;
  // `null` on rows from a backend old enough to send only the flat fields —
  // those fall back to the bare `min/5` they always showed.
  const headline = summary ? feedbackHeadline(summary) : null;
  const hasComment =
    summary?.hasComment ?? (thread.feedbackComment?.trim().length ?? 0) > 0;
  const needsReview =
    (rating != null && rating <= 2) || (rating === 3 && hasComment);

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
        <p className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">
            {thread.visitorDisplayName ?? "Anonymous"}
          </span>
          {thread.synthetic === true ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
              aria-label="Synthetic session"
              role="img"
            />
          ) : null}
          {/* The dot labels the POPULATION and stays synthetic-only; the
              readiness badge follows the data, which real User Testing
              sessions now carry. */}
          {thread.readiness ? (
            <SessionReadinessBadge readiness={thread.readiness} />
          ) : null}
        </p>
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          {thread.toolCallCount ?? thread.messageCount}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {rating != null ? (
          <span
            className={`text-xs font-medium ${
              rating <= 2
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
            }`}
          >
            {/* Average for the headline number, `n×` for how many turns it
                covers — the worst turn is what the amber tint already says,
                so repeating it here would spend the row's one number on a
                fact the color carries.

                A thumbs session has no meaningful average, so it shows its
                tallies instead; a session holding both shows the BLENDED
                average (thumbs projected onto the 1–5 axis, down→1/up→5 —
                `summary.avg` is not a stars-only number) WITH the thumb
                tallies, because dropping either half would under-report how
                many turns were judged. */}
            {headline === null ? (
              `${rating}/5`
            ) : headline.kind === "thumbs" ? (
              formatThumbCounts(headline.up, headline.down)
            ) : headline.kind === "mixed" ? (
              `${headline.avg.toFixed(1)}/5 · ${formatThumbCounts(
                headline.up,
                headline.down
              )}`
            ) : (
              <>
                {headline.avg.toFixed(1)}/5
                {ratingCount > 1 ? ` · ${ratingCount}×` : ""}
              </>
            )}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No feedback</span>
        )}
        {needsReview ? (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3" />
            Needs review
          </span>
        ) : null}
        {/* Sessions started from the in-app Preview pane, not by a tester.
            Only rendered when the session actually carries the tag — older
            sessions predate it and shouldn't be labelled either way. */}
        {thread.surface === "preview" ? (
          <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
            Preview
          </span>
        ) : null}
        {thread.themeClusterLabel ? (
          <span className="max-w-[120px] truncate text-[10px] text-muted-foreground">
            {thread.themeClusterLabel}
          </span>
        ) : null}
        {thread.synthetic === true && thread.personaLabel ? (
          <span className="max-w-[140px] truncate text-[10px] text-muted-foreground">
            {thread.personaLabel}
          </span>
        ) : null}
        {/* Judge verdict — only when a goalScore exists; absence = ungraded,
            not "broken". readiness = "ran cleanly"; judge = "hit the goal". */}
        <SessionGoalScoreBadge goalScore={thread.goalScore} />
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
