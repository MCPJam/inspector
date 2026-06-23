import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  EMPTY_USAGE_FILTER,
  chipKey,
  compareThreadsForUsageList,
  removeChipByKey,
  threadMatchesFilterState,
  toggleChip,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Button } from "@mcpjam/design-system/button";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { ChatboxTopicMapPanel } from "@/components/chatboxes/ChatboxTopicMapPanel";
import { GenerateSessionsDialog } from "@/components/chatboxes/GenerateSessionsDialog";
import { SessionReadinessStrip } from "@/components/chatboxes/session-readiness";
import { buildChatboxSessionPath } from "@/lib/app-navigation";
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
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
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

  const { threads, rebuild } = useUsageInsights({
    sourceType: "chatbox",
    sourceId: chatbox.chatboxId,
    filters: filter,
    enabled: section === "sessions",
  });

  // Apply filter state here (chips + preset) so chips like "Hide synthetic"
  // actually narrow the list — ShareUsageThreadList renders provided threads
  // verbatim when the panel owns the data, so filtering has to happen here.
  const sortedThreads = useMemo(() => {
    if (!threads) return undefined;
    return threads
      .filter((t) => threadMatchesFilterState(t, filter))
      .sort(compareThreadsForUsageList);
  }, [threads, filter]);

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

  // Topic-map dot click → open that session in the Sessions tab. Clear the
  // filter so an active cluster chip can't hide the target thread (the
  // snap-to-first effect would silently reselect another session).
  const handleOpenSessionFromMap = useCallback(
    (sessionId: string) => {
      setSelection({ chatboxId: chatbox.chatboxId, threadId: sessionId });
      setFilter(EMPTY_USAGE_FILTER);
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
      const result = await rebuild({ chatboxId: chatbox.chatboxId });
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
  }, [rebuild, chatbox.chatboxId]);

  if (section === "insights") {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
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
    );
  }

  const hideSyntheticChip: UsageFilterChip = {
    kind: "dimension",
    key: "synthetic",
    value: "hide",
    label: "Hide synthetic",
  };
  const isHideSyntheticActive = filter.chips.some(
    (c) => chipKey(c) === chipKey(hideSyntheticChip)
  );

  return (
    <div className="flex h-full flex-col">
      <GenerateSessionsDialog
        isOpen={generateOpen}
        onClose={() => setGenerateOpen(false)}
        chatbox={chatbox}
      />

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="flex h-full flex-col overflow-hidden">
              {/* min-h matches the thread-detail header across the resize
                  handle so the two border-b lines read as one. */}
              <div className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
                <Button
                  type="button"
                  size="sm"
                  variant={isHideSyntheticActive ? "secondary" : "outline"}
                  className="rounded-full"
                  onClick={() => handleToggleChip(hideSyntheticChip)}
                >
                  Hide synthetic
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => setGenerateOpen(true)}
                >
                  <Sparkles className="mr-1 size-3" />
                  Generate with AI
                </Button>
              </div>
              <SessionReadinessStrip chatboxId={chatbox.chatboxId} />
              <div className="min-h-0 flex-1 overflow-hidden">
                <ShareUsageThreadList
                  threads={sortedThreads}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={setSelectedThreadId}
                  filterState={filter}
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
                    selectedThreadId
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
