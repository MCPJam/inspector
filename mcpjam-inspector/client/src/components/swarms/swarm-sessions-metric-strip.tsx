/**
 * Metric strip for the Swarms Sessions tab: tool error rate, tool calls /
 * session, host latency P50/P95, and tokens / session across the current
 * session scope (project-wide, or narrowed to a persona), with daily-bucket
 * sparklines. Reuses the evals metric tiles; fed by the server-computed
 * `journeyRuns:getSwarmSessionMetrics` aggregate so it never scans sessions
 * client-side (and so it doesn't lie under pagination).
 *
 * Renders nothing while loading or when there are no sessions. Wrap in an
 * ErrorBoundary at the mount site: `useQuery` on an undeployed backend query
 * throws, and the strip must degrade to nothing rather than white-screen the tab.
 */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import { evalSurfaceCardClass } from "@/components/evals/eval-surface-chrome";
import { LatencyTrendMetric, TrendMetric } from "@/components/evals/metric-strip";
import { EvalSparkline } from "@/components/evals/eval-sparkline";
import {
  MIN_TREND_POINTS,
  formatCompactNumber,
} from "@/components/evals/metric-strip-data";
import { SWARM_QUERIES, type SwarmSessionMetrics } from "@/lib/swarm-api";

/** Short day label for sparkline points, e.g. "Jul 3". */
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** One decimal below 10%, whole percent above. `rate` is a 0..1 fraction. */
function formatPercent(rate: number): string {
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

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
      : "skip") as any,
  ) as SwarmSessionMetrics | undefined;

  const pointLabels = useMemo(
    () => (metrics?.trend ?? []).map((p) => formatDay(p.dayStartMs)),
    [metrics],
  );
  const series = useMemo(() => {
    const trend = metrics?.trend ?? [];
    return {
      toolErrorPct: trend.map((p) => (p.toolErrorRate ?? 0) * 100),
      latencyP50: trend.map((p) => p.latencyP50Ms ?? 0),
      latencyP95: trend.map((p) => p.latencyP95Ms ?? 0),
      toolCalls: trend.map((p) => p.avgToolCallsPerSession ?? 0),
      tokens: trend.map((p) => p.avgTokensPerSession ?? 0),
    };
  }, [metrics]);

  const showTrend = (metrics?.trend?.length ?? 0) >= MIN_TREND_POINTS;

  if (!metrics || metrics.sessionCount === 0) return null;

  const {
    toolErrorRate,
    toolCallCount,
    toolErrorCount,
    topFailingTool,
    avgToolCallsPerSession,
    latencyP50Ms,
    latencyP95Ms,
    avgTokensPerSession,
    tokenSampleCount,
    sessionCount,
  } = metrics;

  // Tokens come from write-time counters (independent of readiness analysis),
  // so the backfill gap compares against ALL sessions in scope. Make a partial
  // sample legible instead of silently averaging a subset.
  const tokensSub =
    avgTokensPerSession != null && tokenSampleCount < sessionCount
      ? `${tokenSampleCount} of ${sessionCount} sessions`
      : "per session";

  return (
    <div
      className={cn(
        evalSurfaceCardClass,
        "grid grid-cols-2 overflow-hidden sm:grid-cols-4",
      )}
      data-testid="swarm-sessions-metric-strip"
    >
      <TrendMetric
        divider={false}
        label="Tool errors"
        value={toolErrorRate != null ? formatPercent(toolErrorRate) : "—"}
        sub={
          topFailingTool
            ? `top: ${topFailingTool.toolName} (${topFailingTool.errorCount})`
            : `${toolErrorCount}/${toolCallCount} calls`
        }
        chart={
          showTrend ? (
            <EvalSparkline
              points={series.toolErrorPct}
              pointLabels={pointLabels}
              formatValue={(v) => `${v.toFixed(1)}%`}
              testId="swarm-metric-sparkline-tool-errors"
            />
          ) : undefined
        }
      />
      <LatencyTrendMetric
        p50={latencyP50Ms}
        p95={latencyP95Ms}
        p50Series={series.latencyP50}
        p95Series={series.latencyP95}
        pointLabels={pointLabels}
        showTrend={showTrend}
        subLabel="per session"
      />
      <TrendMetric
        label="Tool calls"
        value={
          avgToolCallsPerSession != null
            ? formatCompactNumber(avgToolCallsPerSession)
            : "—"
        }
        sub="per session"
        chart={
          showTrend ? (
            <EvalSparkline
              points={series.toolCalls}
              pointLabels={pointLabels}
              formatValue={formatCompactNumber}
              testId="swarm-metric-sparkline-tool-calls"
            />
          ) : undefined
        }
      />
      <TrendMetric
        label="Tokens"
        value={
          avgTokensPerSession != null
            ? formatCompactNumber(avgTokensPerSession)
            : "—"
        }
        sub={tokensSub}
        chart={
          showTrend && tokenSampleCount > 0 ? (
            <EvalSparkline
              points={series.tokens}
              pointLabels={pointLabels}
              formatValue={formatCompactNumber}
              testId="swarm-metric-sparkline-tokens"
            />
          ) : undefined
        }
      />
    </div>
  );
}
