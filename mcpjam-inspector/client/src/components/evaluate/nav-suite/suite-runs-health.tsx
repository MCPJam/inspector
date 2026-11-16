/**
 * The Suite page's health on the new pages: the average pass rate over the
 * launches the Runs card shows, the latest one, and a bar per launch.
 */
import { cn } from "@/lib/utils";
import { SuiteHealthBars } from "../suite-health";
import type { SuiteHistoryLaunch } from "../suite-run-history-snapshot";

/** Bars drawn; older launches still count toward nothing on screen. */
const HEALTH_BAR_LIMIT = 30;

const rateOf = (health: { passed: number; total: number }) =>
  (100 * health.passed) / health.total;

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
  // Newest last by the latest run in each launch, as the runs table orders them.
  const ordered = [...launches].sort(
    (a, b) => a.date - b.date || a.runNumber - b.runNumber,
  );
  const scored = ordered
    .flatMap((launch) =>
      launch.health ? [{ ...launch, rate: rateOf(launch.health) }] : [],
    )
    .slice(-HEALTH_BAR_LIMIT);
  const average = scored.length
    ? scored.reduce((sum, launch) => sum + launch.rate, 0) / scored.length
    : null;
  // The newest launch, scored or not, so this agrees with the table's top row.
  const latest = ordered.at(-1) ?? null;
  return (
    <section
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
                latest.verdict === "Failed"
                  ? "text-destructive"
                  : "text-foreground",
              )}
            >
              {latest.verdict}
            </span>
            {latest.health ? (
              <>
                {" · "}
                <span className="tabular-nums">
                  {Math.round(rateOf(latest.health))}% passed ·{" "}
                  {latest.health.passed}/{latest.health.total}
                </span>
              </>
            ) : null}
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
              rate: launch.rate,
              target: { suiteId: launch.suiteId, runId: launch.runId },
            }))}
            threshold={threshold}
            onSelectRun={(target) => onOpenRun(target.runId)}
            startAtNewest
          />
        </div>
      ) : null}
    </section>
  );
}
