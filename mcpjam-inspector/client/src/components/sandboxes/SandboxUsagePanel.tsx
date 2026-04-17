import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import type { SandboxSettings } from "@/hooks/useSandboxes";
import {
  EMPTY_USAGE_FILTER,
  chipKey,
  compareThreadsForUsageList,
  removeChipByKey,
  toggleChip,
  type UsageFilterChip,
  type UsageFilterPreset,
  type UsageFilterState,
} from "@/hooks/sandbox-usage-filters";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { UsageInsightsStrip } from "@/components/shared/usage-insights/UsageInsightsStrip";

interface SandboxUsagePanelProps {
  sandbox: SandboxSettings;
}

const PRESET_OPTIONS: { id: UsageFilterPreset; label: string }[] = [
  { id: "all", label: "All sessions" },
  { id: "needs_review", label: "Needs review" },
  { id: "low_ratings", label: "Low ratings" },
  { id: "no_feedback", label: "No feedback" },
];

export function SandboxUsagePanel({ sandbox }: SandboxUsagePanelProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [filter, setFilter] = useState<UsageFilterState>(EMPTY_USAGE_FILTER);
  const [rebuildBusy, setRebuildBusy] = useState(false);

  const { threads, breakdown, rebuild } = useUsageInsights({
    sourceType: "sandbox",
    sourceId: sandbox.sandboxId,
    filters: filter,
  });

  const sortedThreads = useMemo(() => {
    if (!threads) return undefined;
    return [...threads].sort(compareThreadsForUsageList);
  }, [threads]);

  useEffect(() => {
    setSelectedThreadId(null);
    setFilter(EMPTY_USAGE_FILTER);
  }, [sandbox.sandboxId]);

  useEffect(() => {
    if (!sortedThreads || sortedThreads.length === 0) {
      setSelectedThreadId(null);
      return;
    }
    setSelectedThreadId((current) => {
      if (current && sortedThreads.some((t) => t._id === current)) {
        return current;
      }
      return sortedThreads[0]?._id ?? null;
    });
  }, [sortedThreads]);

  const handleToggleChip = useCallback(
    (chip: UsageFilterChip) => setFilter((prev) => toggleChip(prev, chip)),
    [],
  );
  const handleClearChip = useCallback(
    (key: string) => setFilter((prev) => removeChipByKey(prev, key)),
    [],
  );

  const handleRebuild = useCallback(async () => {
    if (rebuildBusy) return;
    setRebuildBusy(true);
    try {
      const result = await rebuild({ sandboxId: sandbox.sandboxId });
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
      setRebuildBusy(false);
    }
  }, [rebuild, rebuildBusy, sandbox.sandboxId]);

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
            onClick={() =>
              setFilter((prev) => ({ ...prev, chips: [] }))
            }
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
                onClearChip={handleClearChip}
                chipKey={chipKey}
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
