import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { ScenarioSettings } from "@/hooks/useScenarios";
import {
  compareThreadsForUsageList,
  threadMatchesFilterState,
  EMPTY_USAGE_FILTER,
} from "@/hooks/scenario-usage-filters";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { withHideSynthetic } from "@/components/scenarios/user-testing-traffic";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { buildUserTestingScenarioPath } from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/scenario-session";
import { usePromoteCapability } from "@/hooks/usePromoteCapability";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ScenarioSessionsMetricStrip } from "@/components/scenarios/scenario-sessions-metric-strip";
import { ScenarioStageFunnelPanel } from "@/components/shared/user-value-chain/StageFunnelPanels";

interface ScenarioUsagePanelProps {
  scenario: ScenarioSettings;
  /**
   * Thread to preselect on mount (from a `/user-testing/:id?session=` deep
   * link). Falls back to the newest thread if it no longer exists in the list.
   */
  initialThreadId?: string | null;
}

/**
 * The Sessions browser for one User Testing scenario: the thread list, the
 * thread detail, and the metric strip above them.
 *
 * Insights are NOT here. They were, behind a `section` prop, which meant the
 * scenario page mounted this component twice — once per tab — with each
 * instance subscribing to the query the other did not need. Insights now mount
 * `InsightsWorkbench` directly, which is also what Swarms does, so the two
 * surfaces share one body instead of two divergent copies of it.
 */
/**
 * The scenario's traffic policy: the force-applied hide-synthetic chip that
 * every User Testing number is computed over. Insights own the rich chip UI on
 * their own mount, so this panel carries no flow controller — just this policy
 * plus the one rating filter below.
 */
const SESSIONS_TRAFFIC_FILTER = withHideSynthetic(EMPTY_USAGE_FILTER);

/**
 * Rating filter options.
 *
 * Each bucket describes the session's WORST turn, matching the backend's
 * single aggregation policy — "Low" means at least one turn was rated 1–2,
 * not that the average was low.
 */
type RatingFilterValue = "all" | "low" | "neutral" | "high" | "none";

const RATING_FILTER_LABELS: Record<RatingFilterValue, string> = {
  all: "All ratings",
  low: "Low (≤2)",
  neutral: "Neutral (3)",
  high: "High (≥4)",
  none: "No feedback",
};

/**
 * Fold the rating selection into a base filter.
 *
 * `none` is a PRESET (`no_feedback`), not a bucket chip: "nobody rated this"
 * is the absence of a record, and the preset is the shared expression of that
 * on both sides of the wire. The other three are `feedbackBucket` chips.
 *
 * Applied to two different bases: the traffic policy
 * (`SESSIONS_TRAFFIC_FILTER`) for the query and the client-side match, and
 * `EMPTY_USAGE_FILTER` for the list's empty-state copy — the list must see
 * the USER'S selection (so "Low (≤2)" with no matches says "no sessions match
 * the current filters", not "No conversations yet") but not the force-applied
 * hide-synthetic policy chip, which would claim a filter the panel never
 * showed.
 */
function buildRatingFilter(
  rating: RatingFilterValue,
  base: typeof SESSIONS_TRAFFIC_FILTER
) {
  if (rating === "all") return base;
  if (rating === "none") {
    return { ...base, preset: "no_feedback" as const };
  }
  const value =
    rating === "low"
      ? "negative"
      : rating === "neutral"
      ? "neutral"
      : "positive";
  return {
    ...base,
    chips: [
      ...base.chips,
      { kind: "dimension" as const, key: "feedbackBucket" as const, value },
    ],
  };
}

export function ScenarioUsagePanel({
  scenario,
  initialThreadId,
}: ScenarioUsagePanelProps) {
  // Scope selection to the current scenario so switching scenarios can't briefly
  // render a detail pane for a thread belonging to the previous scenario.
  const [selection, setSelection] = useState<{
    scenarioId: string;
    threadId: string | null;
  }>({ scenarioId: scenario.scenarioId, threadId: initialThreadId ?? null });

  // Promotion copies a tester's words into a durable member-owned artifact,
  // so it is member-gated server-side. Resolve the same tier here — the
  // User Testing route is deliberately visible to project guests, unlike
  // Swarms, so the affordance (not the surface) is what gates.
  const { canPromote } = usePromoteCapability({
    projectId: scenario.projectId ?? null,
  });

  const selectedThreadId =
    selection.scenarioId === scenario.scenarioId ? selection.threadId : null;
  const setSelectedThreadId = useCallback(
    (threadId: string | null) =>
      setSelection({ scenarioId: scenario.scenarioId, threadId }),
    [scenario.scenarioId]
  );

  const [ratingFilter, setRatingFilter] = useState<RatingFilterValue>("all");
  const sessionsFilter = useMemo(
    () => buildRatingFilter(ratingFilter, SESSIONS_TRAFFIC_FILTER),
    [ratingFilter]
  );
  // The user-visible half of the filter, for the list's empty-state copy.
  const ratingOnlyFilter = useMemo(
    () => buildRatingFilter(ratingFilter, EMPTY_USAGE_FILTER),
    [ratingFilter]
  );

  const { threads } = useUsageInsights({
    sourceType: "scenario",
    sourceId: scenario.scenarioId,
    filters: sessionsFilter,
    // Sessions only: the breakdown backs Insights, which is a different mount
    // now, so subscribing to it here would scan for a view nobody is looking
    // at.
    threadsEnabled: true,
    breakdownEnabled: false,
  });

  // Belt over the server's braces. The query already applied `sessionsFilter`
  // inside its index walk (which is what makes the filter reach past the
  // 100-row page); re-checking here catches a live update that arrives after
  // the page was built — a session whose rating changes under an open filter.
  const sortedThreads = useMemo(() => {
    if (!threads) return undefined;
    return threads
      .filter((t) => threadMatchesFilterState(t, sessionsFilter))
      .sort(compareThreadsForUsageList);
  }, [threads, sessionsFilter]);

  // Reset thread selection only on scenario *switches*. Guarded by comparing
  // against the previous scenarioId so StrictMode's dev replay does not wipe a
  // deep-linked initialThreadId. Flow filter/selection reset is owned by
  // useInsightsFlowController via cohortKey.
  const prevScenarioIdRef = useRef(scenario.scenarioId);
  useEffect(() => {
    if (prevScenarioIdRef.current === scenario.scenarioId) return;
    prevScenarioIdRef.current = scenario.scenarioId;
    setSelection({
      scenarioId: scenario.scenarioId,
      threadId: initialThreadId ?? null,
    });
  }, [scenario.scenarioId, initialThreadId]);

  useEffect(() => {
    // Don't treat loading (undefined) as empty — that would collapse the
    // detail pane on every refetch and then re-snap to sortedThreads[0]
    // when data arrived.
    if (sortedThreads === undefined) return;
    if (sortedThreads.length === 0) {
      setSelectedThreadId(null);
      return;
    }
    setSelection((current) => {
      if (current.scenarioId !== scenario.scenarioId) {
        return {
          scenarioId: scenario.scenarioId,
          threadId: sortedThreads[0]?._id ?? null,
        };
      }
      if (
        current.threadId &&
        sortedThreads.some((t) => t._id === current.threadId)
      ) {
        return current;
      }
      return {
        scenarioId: scenario.scenarioId,
        threadId: sortedThreads[0]?._id ?? null,
      };
    });
  }, [sortedThreads, scenario.scenarioId, setSelectedThreadId]);

  return (
    <div className="flex h-full flex-col">
      {/* Ships dark: the strip renders nothing until the backend aggregate
          exists and the scenario has sessions, so its spacing lives INSIDE
          the strip rather than in a wrapper that would reserve an empty band
          during the dark window. `useQuery` against an undeployed query
          throws, hence the boundary. */}
      <ErrorBoundary fallback={null}>
        <ScenarioSessionsMetricStrip scenarioId={scenario.scenarioId} />
      </ErrorBoundary>

      {/* D8: this scenario's REAL sessions, and only those — never combined
          with a swarm run's funnel or with eval trials. Self-hiding until the
          backend query exists, same dark-ship reasoning as the strip above. */}
      <ScenarioStageFunnelPanel
        scenarioId={scenario.scenarioId}
        className="mx-3 mb-3"
      />

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="flex h-full flex-col overflow-hidden">
              {/* min-h matches the thread-detail header across the resize
                  handle so the two border-b lines read as one. */}
              <div className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
                <Select
                  value={ratingFilter}
                  onValueChange={(value) =>
                    setRatingFilter(value as RatingFilterValue)
                  }
                >
                  <SelectTrigger
                    data-testid="scenario-sessions-rating-filter"
                    className="h-8 w-[min(100%,10rem)] text-xs"
                    aria-label="Filter sessions by rating"
                  >
                    <SelectValue placeholder="All ratings" />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      Object.keys(RATING_FILTER_LABELS) as RatingFilterValue[]
                    ).map((value) => (
                      <SelectItem key={value} value={value}>
                        {RATING_FILTER_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {/* `filterState` reaches an already-filtered list, so it only
                    feeds the empty-state copy. It carries the rating selection
                    (so an active filter with no matches reads as such) but NOT
                    the force-applied hide-synthetic policy chip, which would
                    tell a scenario with no visitor traffic that "no sessions
                    match the current filters". */}
                <ShareUsageThreadList
                  threads={sortedThreads}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={setSelectedThreadId}
                  filterState={ratingOnlyFilter}
                />
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={70}>
            <div className="h-full overflow-hidden">
              {selectedThreadId ? (
                <ShareUsageThreadDetail
                  threadId={selectedThreadId}
                  sessionLink={`${getShareableAppOrigin()}${buildUserTestingScenarioPath(
                    scenario.scenarioId,
                    { tab: "sessions", session: selectedThreadId }
                  )}`}
                  promote={
                    scenario.projectId
                      ? { projectId: scenario.projectId, canPromote }
                      : undefined
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      {sortedThreads && sortedThreads.length === 0
                        ? "No sessions yet"
                        : "Select a conversation to view"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
