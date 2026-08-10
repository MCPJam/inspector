import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  chipKey,
  compareThreadsForUsageList,
  threadMatchesFilterState,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import {
  useInsightsFlowController,
  useInsightsRebuild,
} from "@/hooks/useInsightsFlowController";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { ChatboxInsightsSankey } from "@/components/chatboxes/ChatboxInsightsSankey";
import {
  ChatboxOutcomeCalibration,
  hasOutcomeFeedbackCalibration,
} from "@/components/chatboxes/ChatboxOutcomeCalibration";
import { ChatboxGoalOutcomeDrilldown } from "@/components/chatboxes/ChatboxGoalOutcomeDrilldown";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { ChatboxTopicMapPanel } from "@/components/chatboxes/ChatboxTopicMapPanel";
import { InsightsStatline } from "@/components/shared/usage-insights/InsightsStatline";
import { InsightsViewToggle } from "@/components/shared/usage-insights/InsightsViewToggle";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { buildUserTestingScenarioPath } from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";
import { usePromoteCapability } from "@/hooks/usePromoteCapability";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ChatboxSessionsMetricStrip } from "@/components/chatboxes/chatbox-sessions-metric-strip";
import { cn } from "@/lib/utils";

export type ChatboxUsagePanelSection = "sessions" | "insights";

interface ChatboxUsagePanelProps {
  chatbox: ChatboxSettings;
  /** Sessions: thread list and detail. Insights: usage dashboards only. */
  section: ChatboxUsagePanelSection;
  /**
   * Thread to preselect on mount (from a `/chatboxes?session=` deep link).
   * Falls back to the newest thread if it no longer exists in the list.
   */
  initialThreadId?: string | null;
  /**
   * Called when the topic map asks to open a session in the Sessions tab.
   * The parent owns the tab switch; this panel handles the thread selection
   * itself (the same instance survives the insights → sessions flip).
   */
  onOpenSession?: (threadId: string) => void;
  /** Open the Sessions tab without selecting a particular session. */
  onOpenSessionsTab?: () => void;
}

/** Filter chip that excludes synthetic (AI-generated) sessions from the list.
 * Chatboxes carry real-user traffic only, but historical synthetic rows from
 * the retired chatbox session-simulation flow are still in the database — this
 * chip is force-applied below so they stay hidden. */
const HIDE_SYNTHETIC_CHIP: UsageFilterChip = {
  kind: "dimension",
  key: "synthetic",
  value: "hide",
  label: "Hide synthetic",
};

function withHideSynthetic(filter: UsageFilterState): UsageFilterState {
  if (filter.chips.some((c) => chipKey(c) === chipKey(HIDE_SYNTHETIC_CHIP))) {
    return filter;
  }
  return { ...filter, chips: [...filter.chips, HIDE_SYNTHETIC_CHIP] };
}

export function ChatboxUsagePanel({
  chatbox,
  section,
  initialThreadId,
  onOpenSession,
  onOpenSessionsTab,
}: ChatboxUsagePanelProps) {
  // Scope selection to the current chatbox so switching chatboxes can't briefly
  // render a detail pane for a thread belonging to the previous chatbox.
  const [selection, setSelection] = useState<{
    chatboxId: string;
    threadId: string | null;
  }>({ chatboxId: chatbox.chatboxId, threadId: initialThreadId ?? null });

  // Promotion copies a tester's words into a durable member-owned artifact,
  // so it is member-gated server-side. Resolve the same tier here — the
  // User Testing route is deliberately visible to project guests, unlike
  // Swarms, so the affordance (not the surface) is what gates.
  //
  // Passing `null` outside the Sessions section short-circuits the hook
  // before it subscribes: only the Sessions detail pane reads `canPromote`,
  // and Insights early-returns above any promote UI. The hook itself still
  // runs on every render, as hook rules require.
  const { canPromote } = usePromoteCapability({
    projectId: section === "sessions" ? chatbox.projectId ?? null : null,
  });

  const selectedThreadId =
    selection.chatboxId === chatbox.chatboxId ? selection.threadId : null;
  const setSelectedThreadId = useCallback(
    (threadId: string | null) =>
      setSelection({ chatboxId: chatbox.chatboxId, threadId }),
    [chatbox.chatboxId],
  );

  const cohortKey = chatbox.chatboxId;
  const flow = useInsightsFlowController({
    cohortKey,
    augmentFilter: withHideSynthetic,
  });

  const { threads, breakdown, rebuild } = useUsageInsights({
    sourceType: "chatbox",
    sourceId: chatbox.chatboxId,
    filters: flow.breakdownFilter,
    // The thread list backs Sessions; the breakdown backs the Insights grid.
    // Subscribing to each only where it renders keeps the tab flip from
    // running two scans at once. (The thread-list query takes no filters —
    // `filters` above only ever reaches the breakdown query.)
    threadsEnabled: section === "sessions",
    breakdownEnabled: section === "insights",
  });

  const { rebuildBusy, handleRebuild, handleApplyTuning } = useInsightsRebuild(
    rebuild,
    cohortKey,
  );

  // Apply filter state here (chips + preset) so chips like "Hide synthetic"
  // actually narrow the list — ShareUsageThreadList renders provided threads
  // verbatim when the panel owns the data, so filtering has to happen here.
  const sortedThreads = useMemo(() => {
    if (!threads) return undefined;
    return threads
      .filter((t) => threadMatchesFilterState(t, flow.effectiveFilter))
      .sort(compareThreadsForUsageList);
  }, [threads, flow.effectiveFilter]);

  // Reset thread selection only on chatbox *switches*. Guarded by comparing
  // against the previous chatboxId so StrictMode's dev replay does not wipe a
  // deep-linked initialThreadId. Flow filter/selection reset is owned by
  // useInsightsFlowController via cohortKey.
  const prevChatboxIdRef = useRef(chatbox.chatboxId);
  useEffect(() => {
    if (prevChatboxIdRef.current === chatbox.chatboxId) return;
    prevChatboxIdRef.current = chatbox.chatboxId;
    setSelection({
      chatboxId: chatbox.chatboxId,
      threadId: initialThreadId ?? null,
    });
  }, [chatbox.chatboxId, initialThreadId]);

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
      if (current.chatboxId !== chatbox.chatboxId) {
        return {
          chatboxId: chatbox.chatboxId,
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
        chatboxId: chatbox.chatboxId,
        threadId: sortedThreads[0]?._id ?? null,
      };
    });
  }, [sortedThreads, chatbox.chatboxId, setSelectedThreadId]);

  // Topic-map dot click → open that session in the Sessions tab. Clear the
  // filter so an active cluster chip can't hide the target thread (the
  // snap-to-first effect would silently reselect another session).
  const handleOpenSessionFromMap = useCallback(
    (sessionId: string) => {
      setSelection({ chatboxId: chatbox.chatboxId, threadId: sessionId });
      flow.clearAllFilters();
      onOpenSession?.(sessionId);
    },
    [chatbox.chatboxId, flow.clearAllFilters, onOpenSession],
  );

  if (section === "insights") {
    const viewToggle = (
      <InsightsViewToggle
        view={flow.view}
        onChange={flow.setView}
        testId="chatbox-insights-view-toggle"
      />
    );

    const chipRow =
      flow.dismissibleChips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-5 py-2">
          {flow.dismissibleChips.map((chip) => {
            const key = chipKey(chip);
            const label =
              chip.kind === "cluster"
                ? (chip.label ?? "Cluster")
                : (chip.label ?? `${chip.key}: ${chip.value}`);
            return (
              <button
                key={key}
                type="button"
                onClick={() => flow.handleClearChip(key)}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
              >
                <span>{label}</span>
                <X className="size-3" />
              </button>
            );
          })}
        </div>
      ) : null;

    const selectionOpen = flow.flowSelection !== null;
    const scope = {
      kind: "chatbox" as const,
      chatboxId: chatbox.chatboxId,
    };
    const showFeedbackChip = hasOutcomeFeedbackCalibration(breakdown);

    return (
      <div
        className="flex h-full min-h-0 flex-col gap-2 overflow-hidden px-8 py-4"
        data-testid="chatbox-insights-panel"
      >
        <InsightsStatline
          breakdown={breakdown}
          filter={flow.filter}
          flowSelection={flow.flowSelection}
          onSelectFlow={flow.handleSelectFlow}
          onToggleChip={flow.handleToggleChip}
          onOpenSessionsTab={onOpenSessionsTab}
          strugglesSlot={
            showFeedbackChip ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-muted/25 px-2 py-0.5 text-xs font-medium tabular-nums transition-colors hover:bg-muted/50"
                    data-testid="chatbox-insights-feedback-chip"
                  >
                    Feedback
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[28rem] max-w-[90vw] p-0"
                >
                  <div className="flex max-h-[60vh] min-h-0 flex-col overflow-y-auto">
                    <ChatboxOutcomeCalibration breakdown={breakdown} />
                  </div>
                </PopoverContent>
              </Popover>
            ) : null
          }
          trailing={viewToggle}
          testId="chatbox-insights-statline"
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {flow.view === "clusters" ? (
              <div className="flex h-full min-h-0 flex-col">
                {chipRow}
                <div className="min-h-0 flex-1">
                  <ChatboxTopicMapPanel
                    chatboxId={chatbox.chatboxId}
                    filter={flow.filter}
                    onToggleChip={flow.handleToggleChip}
                    onClearChip={flow.handleClearChip}
                    onRebuild={handleRebuild}
                    rebuildBusy={rebuildBusy}
                    onOpenSession={handleOpenSessionFromMap}
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ChatboxInsightsSankey
                    breakdown={breakdown}
                    selection={flow.flowSelection}
                    onSelectNode={flow.handleSelectFlow}
                    onSelectLink={flow.handleSelectFlow}
                    onRebuild={handleRebuild}
                    rebuildBusy={rebuildBusy}
                    onApplyTuning={handleApplyTuning}
                    showLinkThreshold
                    fillHeight
                  />
                </div>
                {chipRow}
              </div>
            )}
          </div>
          {flow.view === "flow" ? (
            <div
              className={cn(
                selectionOpen
                  ? "absolute inset-0 z-10 bg-background sm:static sm:w-[22rem] lg:w-[24rem] sm:shrink-0 sm:border-l sm:border-border/40"
                  : "hidden",
              )}
              data-testid="chatbox-insights-drill-panel"
              aria-hidden={!selectionOpen}
            >
              {/* Always mounted (hidden when closed) so close toggles
                  `enabled: false` instead of unmounting — the flow-selection
                  tests pin that contract. */}
              <ChatboxGoalOutcomeDrilldown
                scope={scope}
                selection={flow.flowSelection}
                filter={flow.effectiveFilter}
                variant="panel"
                onClose={flow.handleCloseFlow}
                onOpenSession={handleOpenSessionFromMap}
                footer={
                  onOpenSessionsTab ? (
                    <button
                      type="button"
                      className="self-start text-xs font-medium text-primary hover:underline"
                      onClick={onOpenSessionsTab}
                    >
                      Open in Sessions tab →
                    </button>
                  ) : null
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Ships dark: the strip renders nothing until the backend aggregate
          exists and the scenario has sessions, so its spacing lives INSIDE
          the strip rather than in a wrapper that would reserve an empty band
          during the dark window. `useQuery` against an undeployed query
          throws, hence the boundary. */}
      <ErrorBoundary fallback={null}>
        <ChatboxSessionsMetricStrip chatboxId={chatbox.chatboxId} />
      </ErrorBoundary>

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="flex h-full flex-col overflow-hidden">
              {/* min-h matches the thread-detail header across the resize
                  handle so the two border-b lines read as one. */}
              <div className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2" />
              <div className="min-h-0 flex-1 overflow-hidden">
                <ShareUsageThreadList
                  threads={sortedThreads}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={setSelectedThreadId}
                  filterState={flow.effectiveFilter}
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
                    chatbox.chatboxId,
                    { session: selectedThreadId },
                  )}`}
                  promote={
                    chatbox.projectId
                      ? { projectId: chatbox.projectId, canPromote }
                      : undefined
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      {sortedThreads && sortedThreads.length === 0
                        ? "No sessions match this filter"
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
