import { useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import type {
  ClusterRunState,
  InsightsScope,
} from "@/hooks/useUsageInsights";
import { SCENARIO_INSIGHTS_QUERIES } from "@/lib/scenario-insights-api";

/**
 * "Built 2h ago" — when the analysis behind this view last finished, and
 * whether live traffic has moved past it.
 *
 * `breakdown.latestRun.finishedAt` has been served all along and rendered
 * nowhere, so the surface silently showed stale analysis with no way to tell.
 *
 * STALENESS COMES FROM WATERMARKS, NOT FROM THE RUN. `latestRun.isStale` means
 * a queued/running job blew its 15-minute lease — a stuck job, not old data —
 * and using it here would say "stale" about a perfectly fresh analysis while a
 * retry was pending. The honest signal is `dataStale` from `getWindowSignals`:
 * a session or a rating landed after the newest snapshot's watermarks. The two
 * are surfaced separately, because they ask for different things: one wants a
 * rebuild, the other wants a retry.
 *
 * Specifics live behind the expand, per the minimal-UI norm: the chip is a
 * timestamp, the popover is the run detail plus Rebuild.
 */
export function InsightsFreshnessChip({
  scope,
  latestRun,
  onRebuild,
  rebuildBusy,
  testId,
}: {
  scope: InsightsScope;
  latestRun: ClusterRunState | null | undefined;
  onRebuild: () => void | Promise<unknown>;
  rebuildBusy: boolean;
  testId?: string;
}) {
  // Watermark staleness is a User Testing signal; the swarm surface has no
  // equivalent (a wave's runs are terminal, so its analysis cannot fall
  // behind live traffic). Guarded so the query is only issued where it exists.
  const signals = useQuery(
    SCENARIO_INSIGHTS_QUERIES.getWindowSignals as any,
    (scope.kind === "scenario"
      ? { scenarioId: scope.scenarioId }
      : "skip") as any,
  ) as { dataStale?: boolean } | null | undefined;

  if (!latestRun) return null;

  const running = latestRun.status === "queued" || latestRun.status === "running";
  // A FAILED run has a `finishedAt` like any other terminal run, and reading
  // that as "Built 5 minutes ago" would report a fresh analysis where none was
  // produced. Failure is checked before freshness for that reason.
  const failed = latestRun.status === "failed";
  const builtAt = failed ? null : latestRun.finishedAt;
  const dataStale = signals?.dataStale === true;
  // A lease-expired IN-FLIGHT job is a stuck job, not old data.
  const jobStuck = running && latestRun.isStale;

  const label = jobStuck
    ? "Analysis stuck"
    : running
      ? "Analyzing…"
      : failed
        ? "Analysis failed"
        : builtAt
          ? // `addSuffix` rather than a literal "ago": a backend clock slightly
            // ahead of the viewer's would otherwise render a future timestamp
            // as "Built 5 minutes ago".
            `Built ${formatDistanceToNow(builtAt, { addSuffix: true })}`
          : "Not analyzed";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-muted/25 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-muted/50"
          data-testid={testId}
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : null}
          <span className="truncate">{label}</span>
          {dataStale && !running ? (
            <span
              className="size-1.5 rounded-full bg-amber-500"
              aria-label="New sessions since this analysis"
              data-testid={testId ? `${testId}-stale-dot` : undefined}
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3 text-xs">
        <div className="space-y-1">
          <div className="font-medium">
            {builtAt
              ? `Last analyzed ${formatDistanceToNow(builtAt, { addSuffix: true })}`
              : failed
                ? "The last analysis failed"
                : "This scenario has not been analyzed yet"}
          </div>
          {builtAt ? (
            <div className="text-muted-foreground">
              {latestRun.sessionCount} sessions · {latestRun.clusterCount}{" "}
              themes
            </div>
          ) : null}
          {dataStale ? (
            <div className="text-muted-foreground">
              New sessions have arrived since. Rebuild to include them.
            </div>
          ) : null}
          {jobStuck ? (
            <div className="text-muted-foreground">
              The last analysis stopped responding. Retry it.
            </div>
          ) : null}
          {latestRun.errorMessage ? (
            <div className="text-destructive">{latestRun.errorMessage}</div>
          ) : null}
        </div>
        {/* A run in flight — started here, elsewhere, or before this mount —
            makes Rebuild a redundant second request. A STUCK one is the
            exception: that is exactly what retry is for. */}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium transition-colors hover:bg-muted disabled:opacity-50"
          disabled={rebuildBusy || (running && !jobStuck)}
          onClick={() => void onRebuild()}
          data-testid={testId ? `${testId}-rebuild` : undefined}
        >
          {rebuildBusy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {jobStuck ? "Retry analysis" : failed ? "Retry" : "Rebuild"}
        </button>
      </PopoverContent>
    </Popover>
  );
}
