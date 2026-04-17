import { useEffect, useMemo, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { SandboxSettings } from "@/hooks/useSandboxes";
import {
  compareThreadsForUsageList,
  threadMatchesUsageFilter,
  type UsageSessionFilter,
} from "@/hooks/sandbox-usage-filters";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Button } from "@mcpjam/design-system/button";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { useSharedChatThreadList } from "@/hooks/useSharedChatThreads";

interface SandboxUsagePanelProps {
  sandbox: SandboxSettings;
}

const FILTER_OPTIONS: { id: UsageSessionFilter; label: string }[] = [
  { id: "all", label: "All sessions" },
  { id: "needs_review", label: "Needs review" },
  { id: "low_ratings", label: "Low ratings" },
  { id: "no_feedback", label: "No feedback" },
];

export function SandboxUsagePanel({ sandbox }: SandboxUsagePanelProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [usageFilter, setUsageFilter] = useState<UsageSessionFilter>("all");

  const { threads: rawThreads } = useSharedChatThreadList({
    sourceType: "sandbox",
    sourceId: sandbox.sandboxId,
  });

  const sortedFilteredThreads = useMemo(() => {
    if (!rawThreads) return undefined;
    const filtered =
      usageFilter === "all"
        ? rawThreads
        : rawThreads.filter((t) => threadMatchesUsageFilter(t, usageFilter));
    return [...filtered].sort(compareThreadsForUsageList);
  }, [rawThreads, usageFilter]);

  useEffect(() => {
    setSelectedThreadId(null);
  }, [sandbox.sandboxId]);

  useEffect(() => {
    if (!sortedFilteredThreads || sortedFilteredThreads.length === 0) {
      setSelectedThreadId(null);
      return;
    }
    setSelectedThreadId((current) => {
      if (current && sortedFilteredThreads.some((t) => t._id === current)) {
        return current;
      }
      return sortedFilteredThreads[0]?._id ?? null;
    });
  }, [sortedFilteredThreads]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-2 border-b px-5 py-3">
        {FILTER_OPTIONS.map(({ id, label }) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={usageFilter === id ? "secondary" : "outline"}
            className="rounded-full"
            onClick={() => setUsageFilter(id)}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="h-full overflow-hidden">
              <ShareUsageThreadList
                sourceType="sandbox"
                sourceId={sandbox.sandboxId}
                selectedThreadId={selectedThreadId}
                onSelectThread={setSelectedThreadId}
                usageFilter={usageFilter}
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
                      {sortedFilteredThreads &&
                      sortedFilteredThreads.length === 0
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
