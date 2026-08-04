import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { toast } from "@/lib/toast";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  EMPTY_USAGE_FILTER,
  chipKey,
  compareThreadsForUsageList,
  isSameSelection,
  removeChipByKey,
  removeChipsByKeys,
  selectionChipsToAdd,
  threadMatchesFilterState,
  toggleChip,
  type InsightsSelection,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { ChatboxInsightsSankey } from "@/components/chatboxes/ChatboxInsightsSankey";
import { ChatboxOutcomeCalibration } from "@/components/chatboxes/ChatboxOutcomeCalibration";
import { ChatboxGoalOutcomeDrilldown } from "@/components/chatboxes/ChatboxGoalOutcomeDrilldown";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { ChatboxTopicMapPanel } from "@/components/chatboxes/ChatboxTopicMapPanel";
import { buildChatboxSessionPath, routePaths } from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";

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

export function ChatboxUsagePanel({
  chatbox,
  section,
  initialThreadId,
  onOpenSession,
}: ChatboxUsagePanelProps) {
  // Scope selection to the current chatbox so switching chatboxes can't briefly
  // render a detail pane for a thread belonging to the previous chatbox.
  const [selection, setSelection] = useState<{
    chatboxId: string;
    threadId: string | null;
  }>({ chatboxId: chatbox.chatboxId, threadId: initialThreadId ?? null });
  const [filter, setFilter] = useState<UsageFilterState>(EMPTY_USAGE_FILTER);
  // Chatboxes have no synthetic traffic, so force synthetic sessions out of
  // the fetched + rendered list regardless of the user's own filter chips
  // (historical rows predating the removal stay in the database). Only the
  // data path uses this; the filter UI still shows the user's chips.
  const effectiveFilter = useMemo<UsageFilterState>(() => {
    if (filter.chips.some((c) => chipKey(c) === chipKey(HIDE_SYNTHETIC_CHIP))) {
      return filter;
    }
    return { ...filter, chips: [...filter.chips, HIDE_SYNTHETIC_CHIP] };
  }, [filter]);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  // Synchronous latch so double-clicks can't queue two concurrent rebuilds
  // before React commits `rebuildBusy`.
  const rebuildInFlightRef = useRef(false);
  // Monotonic nonce identifying the currently-owning rebuild invocation.
  // Each call to `handleRebuild` bumps this; the invocation captures its
  // own value, and its `finally` only clears the latch when that nonce
  // still matches — so a stale A-rebuild resolving after B or a later
  // same-chatbox rebuild has started never unlocks the new one.
  const rebuildNonceRef = useRef(0);

  const selectedThreadId =
    selection.chatboxId === chatbox.chatboxId ? selection.threadId : null;
  const setSelectedThreadId = useCallback(
    (threadId: string | null) =>
      setSelection({ chatboxId: chatbox.chatboxId, threadId }),
    [chatbox.chatboxId]
  );

  // Currently-selected flow node or link, driving the paginated drill-down.
  // Kept next to the filter rather than derived from it: an unlabeled node's
  // chip is a sentinel that several stages share, so the selection is not fully
  // recoverable from the chip list alone.
  const [flowSelection, setFlowSelection] = useState<InsightsSelection | null>(
    null
  );
  // The chips the flow actually ADDED, as opposed to the ones its selection
  // implies. They differ whenever the topic map had already written the same
  // chip: the flow click adds nothing, and tearing down by implication would
  // then delete the map's filter. Chip equality cannot express ownership, so it
  // is tracked here.
  const [flowOwnedKeys, setFlowOwnedKeys] = useState<string[]>([]);

  // The breakdown backs the session flow, so the selection's own chips must NOT
  // reach its query: they are the diagram's own OUTPUT. Feeding them back
  // re-runs the scan filtered to the clicked node, which collapses the diagram
  // to the single path that was selected — the selection would erase everything
  // it was selected from. Every other dimension's chips (device, language, the
  // forced synthetic:hide, …) still narrow it; the Sessions list, the map
  // dimming, and the drill-down keep the full filter, because narrowing to the
  // selection is exactly their job.
  //
  // Subtracted by OWNERSHIP, not by what the selection implies: the topic map
  // and the insights strip write cluster chips too, and a chip the flow merely
  // coincided with belongs to whoever wrote it. Removing those would throw away
  // a community the user picked on the map and the diagram would ignore it.
  const breakdownFilter = useMemo(
    () => removeChipsByKeys(effectiveFilter, flowOwnedKeys),
    [effectiveFilter, flowOwnedKeys]
  );

  const { threads, breakdown, rebuild } = useUsageInsights({
    sourceType: "chatbox",
    sourceId: chatbox.chatboxId,
    filters: breakdownFilter,
    // The thread list backs Sessions; the breakdown backs the Insights grid.
    // Subscribing to each only where it renders keeps the tab flip from
    // running two scans at once. (The thread-list query takes no filters —
    // `filters` above only ever reaches the breakdown query.)
    threadsEnabled: section === "sessions",
    breakdownEnabled: section === "insights",
  });

  // Apply filter state here (chips + preset) so chips like "Hide synthetic"
  // actually narrow the list — ShareUsageThreadList renders provided threads
  // verbatim when the panel owns the data, so filtering has to happen here.
  const sortedThreads = useMemo(() => {
    if (!threads) return undefined;
    return threads
      .filter((t) => threadMatchesFilterState(t, effectiveFilter))
      .sort(compareThreadsForUsageList);
  }, [threads, effectiveFilter]);

  // Reset below only on chatbox *switches*. Guarded by comparing against the
  // previous chatboxId (not a mount-skip flag) so the effect is idempotent:
  // StrictMode's dev replay re-runs it with the same chatboxId and must not
  // wipe the deep-linked initialThreadId seed. Re-seeding from initialThreadId
  // (instead of null) also covers the deep link's host applying after this
  // panel mounted — that lands here as a chatbox switch, and the session param
  // is still in the URL.
  const prevChatboxIdRef = useRef(chatbox.chatboxId);
  useEffect(() => {
    if (prevChatboxIdRef.current === chatbox.chatboxId) return;
    prevChatboxIdRef.current = chatbox.chatboxId;
    setSelection({
      chatboxId: chatbox.chatboxId,
      threadId: initialThreadId ?? null,
    });
    setFilter(EMPTY_USAGE_FILTER);
    // A selected flow node may name a cluster belonging to the previous chatbox.
    setFlowSelection(null);
    setFlowOwnedKeys([]);
    // Reset rebuild state too — an in-flight rebuild belongs to the previous
    // chatbox and shouldn't keep this one's button disabled. The old promise
    // still resolves; its nonce no longer matches so its `finally` is a
    // silent no-op.
    rebuildNonceRef.current += 1;
    rebuildInFlightRef.current = false;
    setRebuildBusy(false);
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
  }, [sortedThreads, chatbox.chatboxId]);

  const handleToggleChip = useCallback(
    (chip: UsageFilterChip) => setFilter((prev) => toggleChip(prev, chip)),
    []
  );
  const handleClearChip = useCallback(
    (key: string) => setFilter((prev) => removeChipByKey(prev, key)),
    []
  );

  // Flow node / link click. Uses applySelection (not a series of toggleChip
  // calls) so the themes are REPLACED together — chips OR within an axis, so
  // toggling a second theme on one axis would widen rather than narrow.
  //
  // The previous selection is subtracted BY IDENTITY rather than by clearing
  // the axis: the diagram is not the only writer of theme chips — the topic map
  // writes a goal chip when a community is clicked — so clearing by axis would
  // silently drop a filter the user set elsewhere and widen the cohort behind
  // their back.
  //
  // `flowSelection` is the single source of truth for what is open, and the
  // reopen-vs-close decision is made once, here, from it. Both setters are
  // called at the top level (never one nested inside the other's updater) so
  // StrictMode's double-invoked reducers cannot toggle the filter twice.
  const handleSelectFlow = useCallback(
    (next: InsightsSelection) => {
      const isAlreadyOpen = isSameSelection(flowSelection, next);
      // Computed from the current filter rather than inside a state updater, so
      // StrictMode's double-invoked reducers cannot record ownership twice.
      const cleared = removeChipsByKeys(filter, flowOwnedKeys);
      if (isAlreadyOpen) {
        setFilter(cleared);
        setFlowSelection(null);
        setFlowOwnedKeys([]);
        return;
      }
      const added = selectionChipsToAdd(cleared, next);
      setFilter({ ...cleared, chips: [...cleared.chips, ...added] });
      setFlowSelection(next);
      setFlowOwnedKeys(added.map(chipKey));
    },
    [filter, flowSelection, flowOwnedKeys]
  );

  const handleCloseFlow = useCallback(() => {
    // Drops only what the flow put there, so the diagram cannot keep a theme
    // highlighted with nothing open behind it and an unrelated filter survives.
    setFilter((prev) => removeChipsByKeys(prev, flowOwnedKeys));
    setFlowSelection(null);
    setFlowOwnedKeys([]);
  }, [flowOwnedKeys]);

  // Topic-map dot click → open that session in the Sessions tab. Clear the
  // filter so an active cluster chip can't hide the target thread (the
  // snap-to-first effect would silently reselect another session).
  const handleOpenSessionFromMap = useCallback(
    (sessionId: string) => {
      setSelection({ chatboxId: chatbox.chatboxId, threadId: sessionId });
      setFilter(EMPTY_USAGE_FILTER);
      // The cleared filter no longer encodes a selection, so the diagram
      // highlight and the drill-down panel have to go with it.
      setFlowSelection(null);
      setFlowOwnedKeys([]);
      onOpenSession?.(sessionId);
    },
    [chatbox.chatboxId, onOpenSession]
  );

  const handleRebuild = useCallback(async () => {
    if (rebuildInFlightRef.current) return;
    // Bump the nonce and capture it. The `finally` compares against the
    // current nonce: any later invocation (A→B→A→rebuild-again, or just
    // same-chatbox trigger-again after a chatbox-switch reset) bumps the
    // counter, so the earlier promise's `finally` finds a mismatch and
    // leaves the latch alone for the live rebuild.
    rebuildNonceRef.current += 1;
    const myNonce = rebuildNonceRef.current;
    rebuildInFlightRef.current = true;
    setRebuildBusy(true);
    try {
      const result = await rebuild();
      if (result.alreadyRunning) {
        toast.info("A rebuild is already running");
      } else {
        toast.success("Rebuild queued");
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Rebuild failed. Try again in a few minutes."
      );
    } finally {
      if (rebuildNonceRef.current === myNonce) {
        rebuildInFlightRef.current = false;
        setRebuildBusy(false);
      }
    }
  }, [rebuild]);

  if (section === "insights") {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <ScrollArea className="max-h-[62%] shrink-0 border-b">
          <ChatboxInsightsSankey
            breakdown={breakdown}
            selection={flowSelection}
            onSelectNode={handleSelectFlow}
            onSelectLink={handleSelectFlow}
            onRebuild={handleRebuild}
            rebuildBusy={rebuildBusy}
          />
          <ChatboxGoalOutcomeDrilldown
            scope={{ kind: "chatbox", chatboxId: chatbox.chatboxId }}
            selection={flowSelection}
            filter={effectiveFilter}
            onClose={handleCloseFlow}
            onOpenSession={handleOpenSessionFromMap}
          />
          <ChatboxOutcomeCalibration breakdown={breakdown} />
        </ScrollArea>
        <div className="min-h-0 flex-1">
          <ChatboxTopicMapPanel
            chatboxId={chatbox.chatboxId}
            filter={filter}
            onToggleChip={handleToggleChip}
            onClearChip={handleClearChip}
            onRebuild={handleRebuild}
            rebuildBusy={rebuildBusy}
            onOpenSession={handleOpenSessionFromMap}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
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
                  filterState={effectiveFilter}
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
                  sessionLink={`${getShareableAppOrigin()}${buildChatboxSessionPath(
                    chatbox.namedHostId,
                    selectedThreadId,
                    routePaths.chatboxes
                  )}`}
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
