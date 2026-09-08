/**
 * Metric strip for the Swarms Sessions tab, scoped to the current session
 * scope (project-wide, or narrowed to a persona).
 *
 * Query + scope only; the tiles live in the shared
 * {@link SessionMetricsStripView} because User Testing renders the same
 * aggregate for a scenario. Fed by the server-computed
 * `journeyRuns:getSwarmSessionMetrics` so it never scans sessions client-side (and
 * so it doesn't lie under pagination).
 *
 * Renders nothing while loading or when there are no sessions. Wrap in an
 * ErrorBoundary at the mount site: `useQuery` on an undeployed backend query
 * throws, and the strip must degrade to nothing rather than white-screen the
 * tab.
 */
import { useQuery } from "convex/react";
import { SWARM_QUERIES, type SwarmSessionMetrics } from "@/lib/swarm-api";
import { SessionMetricsStripView } from "@/components/shared/session-metric-strip";
import {
  CollapsibleSessionMetricsShell,
  collapsibleSessionMetricsStorageKey,
} from "@/components/shared/collapsible-session-metrics-shell";
import { usePersistedBoolean } from "@/hooks/use-persisted-boolean";

export function SwarmSessionsMetricStrip({
  projectId,
  personaRefId,
}: {
  projectId: string;
  personaRefId: string | null;
}) {
  const metrics = useQuery(
    SWARM_QUERIES.getSwarmSessionMetrics as any,
    (projectId
      ? { projectId, ...(personaRefId ? { personaRefId } : {}) }
      : "skip") as any
  ) as SwarmSessionMetrics | undefined;
  const [expanded, setExpanded] = usePersistedBoolean(
    collapsibleSessionMetricsStorageKey(),
    true,
  );

  if (!metrics || metrics.sessionCount === 0) return null;

  return (
    <CollapsibleSessionMetricsShell
      expanded={expanded}
      onExpandedChange={setExpanded}
      metrics={metrics}
      testIdPrefix="swarm"
    >
      <SessionMetricsStripView
        metrics={metrics}
        testIdPrefix="swarm"
        embedded
      />
    </CollapsibleSessionMetricsShell>
  );
}
