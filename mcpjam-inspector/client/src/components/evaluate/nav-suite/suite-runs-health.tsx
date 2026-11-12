/**
 * The Suite page's health on the new pages: the average pass rate over the
 * launches the Runs card shows, the latest one, and a bar per launch. Plus
 * the two states a suite has before that: no cases, and cases but no runs.
 */
import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { SuiteHealthBars } from "../suite-health";
import type { SuiteHistoryLaunch } from "../suite-run-history-snapshot";
import type { SuiteDetailNav } from "./suite-page-header";

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

/** In place of the Runs card for a suite with cases that has never run. */
export function SuiteNoRunsHealth() {
  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      aria-label="Suite health"
      data-testid="nav-suite-health"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={AVERAGE_CLASS}>—</span>
        <span className="text-[13px] text-muted-foreground">No runs yet</span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Run the suite once to start a trend.
      </p>
    </section>
  );
}

/** A suite with no cases. Each action is absent when the reader cannot take it. */
export function SuiteNoCasesEmpty({
  onBuildCase,
  onOpenSettings,
}: {
  onBuildCase?: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <section
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-12 text-center"
      data-testid="nav-suite-empty"
    >
      <h3 className="text-base font-semibold text-foreground">
        No test cases yet
      </h3>
      <p className="max-w-md text-sm text-muted-foreground">
        A test case is one prompt and the assertions its answer must pass. Build
        the first one, then run the suite.
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
    </section>
  );
}

/** What the Suite page shows besides the Runs card: nothing once it has runs. */
export function SuiteNavEmptyState({
  hasCases,
  hasRuns,
  nav,
  canEdit,
}: {
  hasCases: boolean;
  hasRuns: boolean;
  nav: Pick<SuiteDetailNav, "onBuildCase" | "onOpenSettings">;
  /** False for read-only and CI-locked suites: no Build a test case. */
  canEdit: boolean;
}) {
  if (!hasCases) {
    return (
      <SuiteNoCasesEmpty
        onBuildCase={canEdit ? nav.onBuildCase : undefined}
        onOpenSettings={nav.onOpenSettings}
      />
    );
  }
  return hasRuns ? null : <SuiteNoRunsHealth />;
}
