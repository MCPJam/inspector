/**
 * The Suite page's health on the new pages: the average pass rate over the
 * launches the Runs card shows, the latest one, and a bar per launch. Plus
 * the two states a suite has before that: no cases, and cases but no runs.
 */
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
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
 * The page's empty states, centered in the space under the header. They fill
 * it when no Runs card sits above them, like today's empty-cases hero.
 */
function SuiteEmptyPanel({
  fill,
  testId,
  children,
}: {
  fill: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-h-[20rem] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-12 text-center",
        fill && "min-h-0 flex-1",
      )}
      data-testid={testId}
    >
      {children}
    </section>
  );
}

/** A suite with cases that has never run, in place of the Runs card. */
export function SuiteNoRunsEmpty({
  runBlockedReason,
  runBusy,
  onRun,
}: {
  runBlockedReason: string | null;
  runBusy: boolean;
  onRun: () => void;
}) {
  return (
    <SuiteEmptyPanel fill testId="nav-suite-no-runs">
      <h3 className="text-base font-semibold text-foreground">No runs yet</h3>
      <p className="max-w-md text-sm text-muted-foreground">
        Run the suite once to start a trend.
      </p>
      <div className="mt-2">
        <SuiteRunButton
          large
          blockedReason={runBlockedReason}
          busy={runBusy}
          onRun={onRun}
        />
      </div>
    </SuiteEmptyPanel>
  );
}

/** A suite with no cases. Each action is absent when the reader cannot take it. */
export function SuiteNoCasesEmpty({
  fill,
  onBuildCase,
  onOpenSettings,
}: {
  /** No Runs card above it. */
  fill: boolean;
  onBuildCase?: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <SuiteEmptyPanel fill={fill} testId="nav-suite-empty">
      <h3 className="text-base font-semibold text-foreground">
        No test cases yet
      </h3>
      <p className="max-w-md text-sm text-muted-foreground">
        Add your first test case, then run the suite.
      </p>
      {onBuildCase ? (
        <Button size="lg" className="mt-2 gap-2" onClick={onBuildCase}>
          <Plus className="size-4" aria-hidden />
          Build a test case
        </Button>
      ) : null}
      {onOpenSettings ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={onOpenSettings}
        >
          or open Suite settings
        </button>
      ) : null}
    </SuiteEmptyPanel>
  );
}

/** What the Suite page shows besides the Runs card: nothing once it has runs. */
export function SuiteNavEmptyState({
  hasCases,
  hasRuns,
  onBuildCase,
  onOpenSettings,
  runBlockedReason,
  runBusy,
  onRun,
}: {
  hasCases: boolean;
  hasRuns: boolean;
  /** Absent for read-only and CI-locked suites. */
  onBuildCase?: () => void;
  onOpenSettings?: () => void;
  runBlockedReason: string | null;
  runBusy: boolean;
  onRun: () => void;
}) {
  if (!hasCases) {
    return (
      <SuiteNoCasesEmpty
        fill={!hasRuns}
        onBuildCase={onBuildCase}
        onOpenSettings={onOpenSettings}
      />
    );
  }
  return hasRuns ? null : (
    <SuiteNoRunsEmpty
      runBlockedReason={runBlockedReason}
      runBusy={runBusy}
      onRun={onRun}
    />
  );
}
