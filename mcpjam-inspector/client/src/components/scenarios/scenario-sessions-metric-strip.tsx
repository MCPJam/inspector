/**
 * Metric strip for a User Testing scenario's Sessions tab.
 *
 * Same tiles and same server-side aggregate as the Swarms strip — only the
 * scope differs (one scenario instead of a project's swarm runs) and the
 * population defaults to REAL testers rather than persona simulations, which
 * is the whole point of this surface.
 *
 * Renders nothing until the backend query exists and the scenario has
 * sessions, so it can ship ahead of the backend deploy. Mount inside an
 * ErrorBoundary: `useQuery` against an undeployed query throws.
 */
import { useQuery } from "convex/react";
import { SessionMetricsStripView } from "@/components/shared/session-metric-strip";
import type { SessionMetricsAggregate } from "@/components/shared/session-metric-strip";

export function ScenarioSessionsMetricStrip({
  scenarioId,
}: {
  scenarioId: string;
}) {
  const metrics = useQuery(
    "chatSessions:getScenarioSessionMetrics" as any,
    (scenarioId ? { scenarioId } : "skip") as any
  ) as SessionMetricsAggregate | undefined | null;

  if (!metrics || metrics.sessionCount === 0) return null;

  return (
    <div className="shrink-0 px-4 pt-3">
      <SessionMetricsStripView metrics={metrics} testIdPrefix="scenario" />
    </div>
  );
}
