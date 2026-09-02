import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  ThreadCard,
} from "@/components/connection/share-usage/ShareUsageThreadList";
import { formatJourneyRelativeTime } from "@/components/swarms/journey-run-format";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type { SwarmSessionRunGroup } from "@/lib/swarm-api";
import { cn } from "@/lib/utils";

interface SwarmSessionsGroupedListProps {
  groups: SwarmSessionRunGroup[];
  threadsById: Map<string, SharedChatThread>;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /**
   * Human labels for group keys this session knows — create-flow / detail
   * supply them. Fresh page loads fall back to a short id suffix.
   */
  runLabels?: ReadonlyMap<string, string>;
  /** "run" | "goal" — drives ungrouped/fallback copy and test ids. */
  groupUnit?: "run" | "goal";
}

function groupLabel(
  group: SwarmSessionRunGroup,
  runLabels: ReadonlyMap<string, string> | undefined,
  groupUnit: "run" | "goal",
): string {
  if (!group.runId) return "Ungrouped sessions";
  const known = runLabels?.get(group.runId);
  if (known) return known;
  const prefix = groupUnit === "goal" ? "Goal" : "Run";
  return `${prefix} ${group.runId.slice(-6)}`;
}

function groupTestId(
  group: SwarmSessionRunGroup,
  groupUnit: "run" | "goal",
): string {
  return group.runId
    ? `swarm-${groupUnit}-group-${group.runId}`
    : `swarm-${groupUnit}-group-ungrouped`;
}

function SwarmSessionGroupSection({
  group,
  defaultOpen,
  groupUnit,
  runLabels,
  threadsById,
  selectedThreadId,
  onSelectThread,
}: {
  group: SwarmSessionRunGroup;
  defaultOpen: boolean;
  groupUnit: "run" | "goal";
  runLabels?: ReadonlyMap<string, string>;
  threadsById: Map<string, SharedChatThread>;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
}) {
  const sessionLabel = `${group.rows.length} session${
    group.rows.length === 1 ? "" : "s"
  }`;
  const sectionTestId = groupTestId(group, groupUnit);
  const holdsSelection =
    selectedThreadId !== null &&
    group.rows.some((row) => row.id === selectedThreadId);

  const [open, setOpen] = useState(defaultOpen || holdsSelection);
  // A deep-linked session can live in any group, and its row may only arrive
  // with a later page — open the group that holds the selection whenever that
  // becomes true, so the list never hides the session the detail pane shows.
  useEffect(() => {
    if (holdsSelection) setOpen(true);
  }, [holdsSelection]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section
        className="overflow-hidden rounded-lg border border-border/60 bg-background shadow-sm"
        data-testid={sectionTestId}
      >
        <CollapsibleTrigger
          className={cn(
            "group/trigger flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors",
            "border-b border-border/60 bg-muted/55 hover:bg-muted/70",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
            "data-[state=closed]:border-b-0",
          )}
          data-testid={`${sectionTestId}-trigger`}
        >
          <div className="flex items-center gap-2">
            <ChevronDown
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/trigger:-rotate-90"
            />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {groupLabel(group, runLabels, groupUnit)}
            </p>
            <span className="shrink-0 font-mono text-[10px] font-medium text-muted-foreground">
              {sessionLabel}
            </span>
          </div>
          <p className="pl-5 text-[10px] text-muted-foreground">
            Latest activity {formatJourneyRelativeTime(group.latestActivityAt)}
          </p>
        </CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            "overflow-hidden bg-background transition-[opacity] duration-200",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
          data-testid={`${sectionTestId}-content`}
        >
          <div className="space-y-1 p-2">
            {group.rows.map((row) => {
              const thread = threadsById.get(row.id);
              if (!thread) return null;
              return (
                <ThreadCard
                  key={row.id}
                  thread={thread}
                  isSelected={row.id === selectedThreadId}
                  onSelect={() => onSelectThread(row.id)}
                />
              );
            })}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function SwarmSessionsGroupedList({
  groups,
  threadsById,
  selectedThreadId,
  onSelectThread,
  runLabels,
  groupUnit = "run",
}: SwarmSessionsGroupedListProps) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-2">
        {groups.map((group, index) => (
          <SwarmSessionGroupSection
            key={group.runId ?? "ungrouped"}
            group={group}
            defaultOpen={index === 0}
            groupUnit={groupUnit}
            runLabels={runLabels}
            threadsById={threadsById}
            selectedThreadId={selectedThreadId}
            onSelectThread={onSelectThread}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

export function SwarmSessionsGroupCount({
  groups,
  canLoadMore,
  unit = "run",
}: {
  groups: SwarmSessionRunGroup[];
  canLoadMore: boolean;
  unit?: "run" | "goal";
}) {
  const sessionCount = groups.reduce(
    (total, group) => total + group.rows.length,
    0,
  );
  const unitLabel = unit === "goal" ? "goal" : "run";
  return (
    <p className="shrink-0 truncate text-xs text-muted-foreground">
      {groups.length}
      {canLoadMore ? "+" : ""} {unitLabel}
      {groups.length === 1 ? "" : "s"} ·{" "}
      {sessionCount}
      {canLoadMore ? "+" : ""} session{sessionCount === 1 ? "" : "s"}
    </p>
  );
}
