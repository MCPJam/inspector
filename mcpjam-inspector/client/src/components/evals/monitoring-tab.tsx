/**
 * Monitoring tab (synthetic monitors) — uptime-style view of a suite's
 * SCHEDULED runs: a clickable pass/fail strip, the probe render-latency
 * trend, and a last-failure card. Interactive runs are deliberately
 * excluded — this surface answers "has the widget kept working unattended",
 * not "what did my last manual run do" (the Runs tab owns that).
 *
 * Visible only when the synthetic-monitors flag is on AND the suite has a
 * schedule or a widget-probe case (gating lives in `suite-dashboard.tsx`).
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { formatRunId } from "./helpers";

export type ScheduledRunStat = {
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: "pending" | "passed" | "failed" | "cancelled";
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  } | null;
  createdAt: number;
  completedAt: number | null;
  probeIterations: number;
  meanRenderLatencyMs: number | null;
};

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function segmentClass(stat: ScheduledRunStat): string {
  if (stat.status === "running" || stat.status === "pending") {
    return "bg-warning/50 hover:bg-warning/70";
  }
  if (stat.result === "passed") return "bg-success/70 hover:bg-success";
  if (stat.result === "failed") return "bg-destructive/70 hover:bg-destructive";
  return "bg-muted-foreground/30 hover:bg-muted-foreground/50";
}

export function MonitoringTab({
  suiteId,
  onRunClick,
}: {
  suiteId: string;
  onRunClick: (runId: string) => void;
}) {
  const stats = useQuery("testSuites:listScheduledRunStats" as any, {
    suiteId,
  }) as ScheduledRunStat[] | undefined;

  // Backend returns newest-first; uptime strips read oldest → newest.
  const chronological = useMemo(
    () => (stats ? [...stats].reverse() : []),
    [stats],
  );
  const lastFailure = useMemo(
    () => stats?.find((stat) => stat.result === "failed") ?? null,
    [stats],
  );
  const latencyTrend = useMemo(
    () =>
      chronological
        .filter((stat) => stat.meanRenderLatencyMs !== null)
        .map((stat) => ({
          runId: stat.runId,
          runIdDisplay: formatRunId(stat.runId),
          latencyMs: stat.meanRenderLatencyMs as number,
          label: formatTimestamp(stat.completedAt ?? stat.createdAt),
        })),
    [chronological],
  );

  if (stats === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (stats.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/10 p-8 text-center">
        <p className="text-sm font-medium text-foreground">
          No scheduled runs yet
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          Enable a schedule in Suite settings and results will appear here as
          an uptime strip — every segment is one unattended run of this suite.
        </p>
      </div>
    );
  }

  const passed = stats.filter((stat) => stat.result === "passed").length;
  const terminal = stats.filter(
    (stat) => stat.result === "passed" || stat.result === "failed",
  ).length;
  const passRatePct =
    terminal > 0 ? Math.round((passed / terminal) * 100) : null;

  return (
    <div className="flex flex-col gap-5">
      {/* ── pass/fail strip ─────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Scheduled runs
          </h3>
          <span className="text-xs tabular-nums text-muted-foreground">
            {passRatePct !== null
              ? `${passRatePct}% passing · last ${stats.length} run${stats.length === 1 ? "" : "s"}`
              : `${stats.length} run${stats.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div
          className="flex h-8 items-stretch gap-[3px]"
          role="list"
          aria-label="Scheduled run results, oldest to newest"
        >
          {chronological.map((stat) => (
            <button
              key={stat.runId}
              type="button"
              role="listitem"
              onClick={() => onRunClick(stat.runId)}
              className={cn(
                "min-w-[6px] flex-1 rounded-[3px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                segmentClass(stat),
              )}
              title={`${formatTimestamp(stat.completedAt ?? stat.createdAt)} — ${
                stat.result === "pending" ? stat.status : stat.result
              }${
                stat.summary
                  ? ` (${stat.summary.passed}/${stat.summary.total} iterations)`
                  : ""
              }`}
              aria-label={`Run ${formatRunId(stat.runId)}: ${stat.result}`}
            />
          ))}
        </div>
      </section>

      {/* ── probe latency trend ─────────────────────────────────────── */}
      {latencyTrend.length > 1 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Widget render latency
          </h3>
          <ChartContainer
            config={{
              latencyMs: {
                label: "Mean render ms",
                color: "hsl(var(--chart-2, 220 70% 50%))",
              },
            }}
            className="aspect-auto h-28 w-full"
          >
            <AreaChart
              data={latencyTrend}
              margin={{ top: 12, right: 6, left: 6, bottom: 2 }}
            >
              <XAxis dataKey="label" hide padding={{ left: 8, right: 8 }} />
              <YAxis hide domain={[0, "dataMax"]} />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent indicator="line" />}
              />
              <Area
                type="monotone"
                dataKey="latencyMs"
                stroke="var(--color-latencyMs)"
                fill="var(--color-latencyMs)"
                fillOpacity={0.12}
                strokeWidth={2}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ChartContainer>
        </section>
      ) : null}

      {/* ── last failure ────────────────────────────────────────────── */}
      {lastFailure ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Last failure
          </h3>
          <button
            type="button"
            onClick={() => onRunClick(lastFailure.runId)}
            className="w-full rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-left transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">
                Run {formatRunId(lastFailure.runId)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {formatTimestamp(
                  lastFailure.completedAt ?? lastFailure.createdAt,
                )}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {lastFailure.summary
                ? `${lastFailure.summary.failed} of ${lastFailure.summary.total} iterations failed.`
                : "Run did not complete."}{" "}
              Open the run to see check verdicts and the rendered widget.
            </p>
          </button>
        </section>
      ) : null}
    </div>
  );
}
