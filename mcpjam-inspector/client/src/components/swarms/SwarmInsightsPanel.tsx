import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import {
  EMPTY_USAGE_FILTER,
  chipKey,
  isSameSelection,
  removeChipsByKeys,
  selectionChipsToAdd,
  type InsightsSelection,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import { useUsageInsights, type InsightsScope } from "@/hooks/useUsageInsights";
import { ChatboxInsightsSankey } from "@/components/chatboxes/ChatboxInsightsSankey";
import { ChatboxGoalOutcomeDrilldown } from "@/components/chatboxes/ChatboxGoalOutcomeDrilldown";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";

interface SwarmInsightsPanelProps {
  projectId: string | null;
  /** Open a session in the Sessions browser (the parent owns the tab flip). */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * The Insights view for Swarms: the same four-stage session flow the chatbox
 * Insights tab renders, over a project's swarm sessions.
 *
 * Shares the sankey, the drill-down, and the selection/chip mechanics with the
 * chatbox panel — the one visible difference is the first column's header:
 * swarm goals are journeys, assigned deterministically rather than clustered,
 * so the column is named for what it actually is.
 *
 * No topic map and no feedback calibration: both are chatbox-surface features
 * (goal embeddings / visitor feedback) that swarm sessions don't have.
 */
export function SwarmInsightsPanel({
  projectId,
  onOpenSession,
}: SwarmInsightsPanelProps) {
  const scope = useMemo<InsightsScope | null>(
    () => (projectId ? { kind: "swarm", projectId } : null),
    [projectId],
  );

  const [filter, setFilter] = useState<UsageFilterState>(EMPTY_USAGE_FILTER);
  const [flowSelection, setFlowSelection] = useState<InsightsSelection | null>(
    null,
  );
  // The chips the flow actually ADDED — ownership, not implication — mirroring
  // the chatbox panel's contract so teardown never deletes a chip another
  // writer put there.
  const [flowOwnedKeys, setFlowOwnedKeys] = useState<string[]>([]);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const rebuildInFlightRef = useRef(false);

  // Reset on project switches: a selected flow node names a cluster belonging
  // to the previous project.
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current === projectId) return;
    prevProjectIdRef.current = projectId;
    setFilter(EMPTY_USAGE_FILTER);
    setFlowSelection(null);
    setFlowOwnedKeys([]);
    rebuildInFlightRef.current = false;
    setRebuildBusy(false);
  }, [projectId]);

  // The selection's own chips must not reach the breakdown query — they are
  // the diagram's own output, and feeding them back collapses the diagram to
  // the selected path. Same ownership subtraction as the chatbox panel.
  const breakdownFilter = useMemo(
    () => removeChipsByKeys(filter, flowOwnedKeys),
    [filter, flowOwnedKeys],
  );

  const { breakdown, rebuild } = useUsageInsights({
    scope,
    filters: breakdownFilter,
    threadsEnabled: false,
    breakdownEnabled: scope !== null,
  });

  const handleSelectFlow = useCallback(
    (next: InsightsSelection) => {
      const isAlreadyOpen = isSameSelection(flowSelection, next);
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
    [filter, flowSelection, flowOwnedKeys],
  );

  const handleCloseFlow = useCallback(() => {
    setFilter((prev) => removeChipsByKeys(prev, flowOwnedKeys));
    setFlowSelection(null);
    setFlowOwnedKeys([]);
  }, [flowOwnedKeys]);

  const handleRebuild = useCallback(async () => {
    if (rebuildInFlightRef.current) return;
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
          : "Rebuild failed. Try again in a few minutes.",
      );
    } finally {
      rebuildInFlightRef.current = false;
      setRebuildBusy(false);
    }
  }, [rebuild]);

  if (!scope) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to view swarm insights.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ChatboxInsightsSankey
        breakdown={breakdown}
        selection={flowSelection}
        onSelectNode={handleSelectFlow}
        onSelectLink={handleSelectFlow}
        onRebuild={handleRebuild}
        rebuildBusy={rebuildBusy}
        stageTitles={{ goal: "Journey" }}
      />
      <ChatboxGoalOutcomeDrilldown
        scope={scope}
        selection={flowSelection}
        filter={filter}
        onClose={handleCloseFlow}
        onOpenSession={(sessionId) => onOpenSession?.(sessionId)}
      />
    </ScrollArea>
  );
}
