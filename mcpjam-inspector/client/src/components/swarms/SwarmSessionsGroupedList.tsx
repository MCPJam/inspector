import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  ThreadCard,
} from "@/components/connection/share-usage/ShareUsageThreadList";
import { formatJourneyRelativeTime } from "@/components/swarms/journey-run-format";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type { SwarmSessionRunGroup } from "@/lib/swarm-api";

interface SwarmSessionsGroupedListProps {
  groups: SwarmSessionRunGroup[];
  threadsById: Map<string, SharedChatThread>;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /**
   * Human labels ("Persona · Journey") for runs whose names this session
   * happens to know — the create flow supplies them for the runs it just
   * launched. Every other run falls back to its id, which is all a fresh page
   * load can honestly say.
   */
  runLabels?: ReadonlyMap<string, string>;
}

function runGroupLabel(
  group: SwarmSessionRunGroup,
  runLabels?: ReadonlyMap<string, string>
): string {
  if (!group.runId) return "Ungrouped sessions";
  return runLabels?.get(group.runId) ?? `Run ${group.runId.slice(-6)}`;
}

export function SwarmSessionsGroupedList({
  groups,
  threadsById,
  selectedThreadId,
  onSelectThread,
  runLabels,
}: SwarmSessionsGroupedListProps) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-2">
        {groups.map((group) => {
          const sessionLabel = `${group.rows.length} session${
            group.rows.length === 1 ? "" : "s"
          }`;
          return (
            <section
              key={group.runId ?? "ungrouped"}
              className="overflow-hidden rounded-lg border border-border/50"
              data-testid={
                group.runId
                  ? `swarm-run-group-${group.runId}`
                  : "swarm-run-group-ungrouped"
              }
            >
              <div className="border-b border-border/40 bg-muted/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-semibold text-foreground">
                    {runGroupLabel(group, runLabels)}
                  </p>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {sessionLabel}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Latest activity {formatJourneyRelativeTime(group.latestActivityAt)}
                </p>
              </div>
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
            </section>
          );
        })}
      </div>
    </ScrollArea>
  );
}

export function SwarmSessionsGroupCount({
  groups,
  canLoadMore,
}: {
  groups: SwarmSessionRunGroup[];
  canLoadMore: boolean;
}) {
  const sessionCount = groups.reduce(
    (total, group) => total + group.rows.length,
    0,
  );
  return (
    <p className="shrink-0 truncate text-xs text-muted-foreground">
      {groups.length}
      {canLoadMore ? "+" : ""} run{groups.length === 1 ? "" : "s"} ·{" "}
      {sessionCount}
      {canLoadMore ? "+" : ""} session{sessionCount === 1 ? "" : "s"}
    </p>
  );
}
