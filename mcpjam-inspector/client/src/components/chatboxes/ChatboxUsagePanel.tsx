import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  compareThreadsForUsageList,
  threadMatchesFilterState,
  EMPTY_USAGE_FILTER,
} from "@/hooks/chatbox-usage-filters";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { withHideSynthetic } from "@/components/chatboxes/user-testing-traffic";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { buildUserTestingScenarioPath } from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";
import { usePromoteCapability } from "@/hooks/usePromoteCapability";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ChatboxSessionsMetricStrip } from "@/components/chatboxes/chatbox-sessions-metric-strip";

interface ChatboxUsagePanelProps {
  chatbox: ChatboxSettings;
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
 * The scenario's traffic policy, fixed. With Insights on its own mount there
 * is no filter UI left here — no chips, no diagram, no view toggle — so the
 * only chip in play is the force-applied hide-synthetic one, and a whole flow
 * controller (view state, selection, chip ownership, a window keydown
 * listener) would be carried for nothing.
 */
const SESSIONS_FILTER = withHideSynthetic(EMPTY_USAGE_FILTER);

export function ChatboxUsagePanel({
  chatbox,
  initialThreadId,
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
  const { canPromote } = usePromoteCapability({
    projectId: chatbox.projectId ?? null,
  });

  const selectedThreadId =
    selection.chatboxId === chatbox.chatboxId ? selection.threadId : null;
  const setSelectedThreadId = useCallback(
    (threadId: string | null) =>
      setSelection({ chatboxId: chatbox.chatboxId, threadId }),
    [chatbox.chatboxId],
  );

  const { threads } = useUsageInsights({
    sourceType: "chatbox",
    sourceId: chatbox.chatboxId,
    filters: SESSIONS_FILTER,
    // Sessions only: the breakdown backs Insights, which is a different mount
    // now, so subscribing to it here would scan for a view nobody is looking
    // at. (The thread-list query takes no filters — `filters` above only ever
    // reaches the breakdown query.)
    threadsEnabled: true,
    breakdownEnabled: false,
  });

  // Apply filter state here (chips + preset) so chips like "Hide synthetic"
  // actually narrow the list — ShareUsageThreadList renders provided threads
  // verbatim when the panel owns the data, so filtering has to happen here.
  const sortedThreads = useMemo(() => {
    if (!threads) return undefined;
    return threads
      .filter((t) => threadMatchesFilterState(t, SESSIONS_FILTER))
      .sort(compareThreadsForUsageList);
  }, [threads]);

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
                {/* `filterState` reaches an already-filtered list, so it only
                    feeds the empty-state copy. Handing it the force-applied
                    policy chip would tell a scenario with no visitor traffic
                    that "no sessions match the current filters" and offer to
                    clear chart chips this panel does not have. */}
                <ShareUsageThreadList
                  threads={sortedThreads}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={setSelectedThreadId}
                  filterState={EMPTY_USAGE_FILTER}
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
                    { tab: "sessions", session: selectedThreadId },
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
