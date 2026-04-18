import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import {
  EMPTY_USAGE_FILTER,
  compareThreadsForUsageList,
  removeChipByKey,
  toggleChip,
  type UsageFilterChip,
  type UsageFilterPreset,
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
import { UsageInsightsStrip } from "@/components/shared/usage-insights/UsageInsightsStrip";

interface ChatboxUsagePanelProps {
  chatbox: ChatboxSettings;
}

const PRESET_OPTIONS: { id: UsageFilterPreset; label: string }[] = [
  { id: "all", label: "All sessions" },
  { id: "needs_review", label: "Needs review" },
  { id: "low_ratings", label: "Low ratings" },
  { id: "no_feedback", label: "No feedback" },
];

export function ChatboxUsagePanel({ chatbox }: ChatboxUsagePanelProps) {
  // Scope selection to the current chatbox so switching chatboxes can't briefly
  // render a detail pane for a thread belonging to the previous chatbox.
  const [selection, setSelection] = useState<{
    chatboxId: string;
    threadId: string | null;
  }>({ chatboxId: chatbox.chatboxId, threadId: null });
  const [filter, setFilter] = useState<UsageFilterState>(EMPTY_USAGE_FILTER);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  // Synchronous latch so double-clicks can't queue two concurrent rebuilds
  // before React commits `rebuildBusy`.
  const rebuildInFlightRef = useRef(false);

  const selectedThreadId =
    selection.chatboxId === chatbox.chatboxId ? selection.threadId : null;
  const setSelectedThreadId = useCallback(
    (threadId: string | null) =>
      setSelection({ chatboxId: chatbox.chatboxId, threadId }),
    [chatbox.chatboxId],
  );

  const { threads, breakdown, rebuild } = useUsageInsights({
    sourceType: "chatbox",
    sourceId: chatbox.chatboxId,
    filters: filter,
  });

  const sortedThreads = useMemo(() => {
    if (!threads) return undefined;
    return [...threads].sort(compareThreadsForUsageList);
  }, [threads]);

  useEffect(() => {
    setSelection({ chatboxId: chatbox.chatboxId, threadId: null });
    setFilter(EMPTY_USAGE_FILTER);
    // Reset rebuild state too — an in-flight rebuild belongs to the previous
    // chatbox and shouldn't keep this one's button disabled. The old promise
    // still resolves; its result just gets ignored because it points at a
    // stale chatbox id.
    rebuildInFlightRef.current = false;
    setRebuildBusy(false);
  }, [chatbox.chatboxId]);

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
        return { chatboxId: chatbox.chatboxId, threadId: sortedThreads[0]?._id ?? null };
      }
      if (current.threadId && sortedThreads.some((t) => t._id === current.threadId)) {
        return current;
      }
      return {
        chatboxId: chatbox.chatboxId,
        threadId: sortedThreads[0]?._id ?? null,
      };
    });
  }, [sortedThreads, chatbox.chatboxId, setSelectedThreadId]);

  const handleToggleChip = useCallback(
    (chip: UsageFilterChip) => setFilter((prev) => toggleChip(prev, chip)),
    [],
  );
  const handleClearChip = useCallback(
    (key: string) => setFilter((prev) => removeChipByKey(prev, key)),
    [],
  );

  const handleRebuild = useCallback(async () => {
    if (rebuildInFlightRef.current) return;
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
          : "Rebuild failed. Try again in a few minutes.",
      );
    } finally {
      rebuildInFlightRef.current = false;
      setRebuildBusy(false);
    }
  }, [rebuild, chatbox.chatboxId]);

  return (
    <div className="flex h-full flex-col">
      <UsageInsightsStrip
        breakdown={breakdown}
        filter={filter}
        onToggleChip={handleToggleChip}
        onClearChip={handleClearChip}
        onRebuild={handleRebuild}
        rebuildBusy={rebuildBusy}
      />

      <div className="flex flex-wrap gap-2 border-b px-5 py-3">
        {PRESET_OPTIONS.map(({ id, label }) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={filter.preset === id ? "secondary" : "outline"}
            className="rounded-full"
            onClick={() => setFilter((prev) => ({ ...prev, preset: id }))}
          >
            {label}
          </Button>
        ))}
        {filter.chips.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto rounded-full text-xs"
            onClick={() => setFilter((prev) => ({ ...prev, chips: [] }))}
          >
            Clear chart filters
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="h-full overflow-hidden">
              <ShareUsageThreadList
                threads={sortedThreads}
                selectedThreadId={selectedThreadId}
                onSelectThread={setSelectedThreadId}
                filterState={filter}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={70}>
            <div className="h-full overflow-hidden">
              {selectedThreadId ? (
                <ShareUsageThreadDetail threadId={selectedThreadId} />
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
