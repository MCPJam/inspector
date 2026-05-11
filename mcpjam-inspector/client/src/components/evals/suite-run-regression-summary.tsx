import { useMemo } from "react";
import type { EvalIteration } from "./types";
import { computeSuiteRegression, type SuiteRegressionReport } from "./regression";

type SuiteRunRegressionSummaryProps = {
  currentIterations: EvalIteration[];
  previousIterations: EvalIteration[];
  /**
   * Percentage drop above which a `(testCaseId, executionConfigKey)` pair
   * is flagged as a regression. Default 10. Read from
   * `suite.regressionThresholdPct` when wired through.
   */
  thresholdPct?: number;
  /**
   * Map of testCaseId -> human-readable title. Used to label badges in
   * the summary. Optional — if a case id has no entry we fall back to a
   * truncated id.
   */
  titleByCaseId?: Record<string, string>;
};

/**
 * Compact summary of pass-rate regressions vs the previous suite run on
 * the same suite. Renders nothing when there's nothing to compare or
 * nothing to flag.
 */
export function SuiteRunRegressionSummary({
  currentIterations,
  previousIterations,
  thresholdPct = 10,
  titleByCaseId,
}: SuiteRunRegressionSummaryProps) {
  const report: SuiteRegressionReport = useMemo(
    () =>
      computeSuiteRegression(
        currentIterations,
        previousIterations,
        thresholdPct,
      ),
    [currentIterations, previousIterations, thresholdPct],
  );

  if (
    report.comparable.length === 0 &&
    report.addedPairs.length === 0 &&
    report.removedPairs.length === 0
  ) {
    return null;
  }

  const flagged = report.comparable.filter((e) => e.exceededThreshold);

  if (flagged.length === 0) {
    return (
      <div
        role="status"
        className="rounded-md border border-border/40 bg-muted/10 px-3 py-2 text-xs text-muted-foreground"
      >
        No regressions vs previous run (threshold {thresholdPct}%).
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="space-y-1.5 rounded-md border border-red-500/40 bg-red-500/5 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-red-700 dark:text-red-300">
          {flagged.length} regression{flagged.length === 1 ? "" : "s"} vs
          previous run
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          threshold {thresholdPct}%
        </div>
      </div>
      <ul className="space-y-1 text-xs">
        {flagged.map((entry) => {
          const label =
            titleByCaseId?.[entry.testCaseId] ??
            `case ${entry.testCaseId.slice(0, 8)}`;
          return (
            <li
              key={`${entry.testCaseId}::${entry.executionConfigKey}`}
              className="flex items-center justify-between gap-3 rounded border border-red-500/30 bg-background/50 px-2 py-1"
            >
              <span className="truncate font-medium">{label}</span>
              <span className="font-mono text-[11px] tabular-nums text-red-700 dark:text-red-300">
                {formatPct(entry.previousPassRate)} → {formatPct(entry.currentPassRate)}{" "}
                <span className="text-muted-foreground">
                  (−{formatPct(entry.drop, { signed: false })})
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatPct(
  rate: number,
  options?: { signed?: boolean },
): string {
  const pct = Math.round(rate * 100);
  if (options?.signed && pct >= 0) return `+${pct}%`;
  return `${pct}%`;
}
