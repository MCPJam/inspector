/**
 * The Suite page's health on the new pages: the average pass rate over the
 * launches the Runs card shows, the latest one, and a bar per launch. Plus
 * the two states a suite has before that: no cases, and cases but no runs.
 */
import type { ReactNode } from "react";
import { ListChecks } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { SuiteHealthBars } from "../suite-health";
import { SuiteRunButton } from "./suite-page-header";
import type { SuiteHistoryLaunch } from "../suite-run-history-snapshot";

/** Bars drawn; older launches still count toward nothing on screen. */
const HEALTH_BAR_LIMIT = 30;

const AVERAGE_CLASS =
  "text-[40px] font-semibold leading-[44px] tracking-tight tabular-nums text-foreground";

export function SuiteRunsHealth({
  launches,
  threshold,
  onOpenRun,
}: {
  /** Oldest first, already narrowed by the Runs card's filters. */
  launches: readonly SuiteHistoryLaunch[];
  /** Percent; null draws no threshold line. */
  threshold: number | null;
  onOpenRun: (runId: string) => void;
}) {
  const scored = launches
    .filter((launch) => launch.point.total > 0)
    .slice(-HEALTH_BAR_LIMIT);
  const average = scored.length
    ? scored.reduce(
        (sum, launch) => sum + (100 * launch.point.passed) / launch.point.total,
        0,
      ) / scored.length
    : null;
  const latest = scored.at(-1) ?? null;
  const passed = latest?.result === "passed";
  return (
    <div
      className="border-b border-border/50 px-5 py-3.5"
      aria-label="Suite health"
      data-testid="nav-suite-health"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={AVERAGE_CLASS}>
          {average == null ? "—" : `${Math.round(average)}%`}
        </span>
        <span className="text-[13px] text-muted-foreground">
          {scored.length
            ? `average across the last ${
                scored.length === 1 ? "run" : `${scored.length} runs`
              }`
            : "No scored runs"}
        </span>
        {latest ? (
          <span className="ml-auto text-xs text-muted-foreground">
            Last run{" "}
            <button
              type="button"
              className="font-medium text-foreground hover:underline"
              onClick={() => onOpenRun(latest.runId)}
            >
              #{latest.runNumber}
            </button>
            {" · "}
            <span
              className={cn(
                "font-semibold",
                passed ? "text-success" : "text-destructive",
              )}
            >
              {passed ? "Passed" : "Failed"} {latest.point.passRate}%
            </span>
            {" · "}
            <span className="tabular-nums">
              {latest.point.passed}/{latest.point.total} passed
            </span>
          </span>
        ) : null}
      </div>
      {scored.length ? (
        <div className="mt-2">
          <SuiteHealthBars
            points={scored.map((launch) => ({
              key: launch.runId,
              runNumber: launch.runNumber,
              date: launch.date,
              rate: (100 * launch.point.passed) / launch.point.total,
              target: { suiteId: launch.suiteId, runId: launch.runId },
            }))}
            threshold={threshold}
            onSelectRun={(target) => onOpenRun(target.runId)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tab's empty state, centered in the space under the tabs, like today's
 * empty-cases hero.
 */
function SuiteEmptyPanel({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex min-h-[20rem] flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-12 text-center"
      data-testid={testId}
    >
      {children}
    </section>
  );
}

/**
 * The Runs tab of a suite with cases that has never run: a nudge to run them,
 * or to go back to the cases just added.
 */
export function SuiteNoRunsEmpty({
  caseCount,
  runBlockedReason,
  runBusy,
  onRun,
  onViewCases,
}: {
  caseCount: number;
  runBlockedReason: string | null;
  runBusy: boolean;
  onRun: () => void;
  onViewCases: () => void;
}) {
  return (
    <SuiteEmptyPanel testId="nav-suite-no-runs">
      <h3 className="text-base font-semibold text-foreground">No runs yet</h3>
      <p className="max-w-md text-sm text-muted-foreground">
        Run your {caseCount} test {caseCount === 1 ? "case" : "cases"} to start
        a trend.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <SuiteRunButton
          large
          blockedReason={runBlockedReason}
          busy={runBusy}
          onRun={onRun}
        />
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="gap-2"
          onClick={onViewCases}
        >
          <ListChecks className="size-4" aria-hidden />
          View test cases
        </Button>
      </div>
    </SuiteEmptyPanel>
  );
}
