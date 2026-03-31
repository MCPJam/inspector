import { cn } from "@/lib/utils";
import { formatDuration } from "./helpers";
import type { EvalSuiteRun } from "./types";

export type RunHeaderCompactStatsOverride = {
  passed: number;
  failed: number;
  total: number;
  /** Stored like summary: decimal 0–1 or 0–100. */
  passRate: number;
};

function normalizePassRatePercent(passRate: number): number {
  if (passRate <= 1 && passRate > 0) {
    return Math.round(passRate * 100);
  }
  return Math.round(passRate);
}

/**
 * Pass-rate label for the run-detail sidebar "Run Insights" row only.
 * Returns null when there is no meaningful summary (matches compact-stats empty states).
 */
export function getSidebarRunInsightsPassRateLabel(
  run: EvalSuiteRun,
  statsOverride?: RunHeaderCompactStatsOverride,
): string | null {
  const summary = statsOverride ?? run.summary;
  if (!summary || summary.total === 0) {
    return null;
  }
  const pct = normalizePassRatePercent(summary.passRate);
  return `${pct}%`;
}

export function RunHeaderCompactStats({
  run,
  statsOverride,
  className,
}: {
  run: EvalSuiteRun;
  statsOverride?: RunHeaderCompactStatsOverride;
  className?: string;
}) {
  const isInProgress =
    run.status === "running" || run.status === "pending";

  const durationText =
    run.completedAt && run.createdAt
      ? formatDuration(run.completedAt - run.createdAt)
      : "—";

  if (isInProgress) {
    return (
      <p
        className={cn(
          "text-xs text-muted-foreground tabular-nums",
          className,
        )}
      >
        Run in progress
        {statsOverride || run.summary
          ? ` · ${(statsOverride ?? run.summary)!.passed.toLocaleString()} passed · ${(statsOverride ?? run.summary)!.failed.toLocaleString()} failed`
          : ""}
      </p>
    );
  }

  const summary = statsOverride ?? run.summary;
  if (!summary || summary.total === 0) {
    return (
      <p
        className={cn(
          "text-xs text-muted-foreground tabular-nums",
          className,
        )}
      >
        {summary && summary.total === 0
          ? "No cases in run"
          : "No run summary yet"}
        {durationText !== "—" ? ` · ${durationText}` : ""}
      </p>
    );
  }

  const pct = normalizePassRatePercent(summary.passRate);

  return (
    <p
      className={cn(
        "text-xs text-muted-foreground tabular-nums",
        className,
      )}
    >
      {summary.passed.toLocaleString()} passed ·{" "}
      {summary.failed.toLocaleString()} failed · {pct}% · {durationText}
    </p>
  );
}
