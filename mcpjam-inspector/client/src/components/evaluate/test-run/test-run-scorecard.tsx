import { ArrowUpRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type { TestRunScorecard } from "./test-run-scorecard-model";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Every check of the case, with how many iterations passed it. */
export function TestRunScorecardTable({
  scorecard,
  onOpenIteration,
}: {
  scorecard: TestRunScorecard;
  onOpenIteration?: (iterationId: string) => void;
}) {
  return (
    <section aria-labelledby="test-run-scorecards" className="space-y-2">
      <h3
        id="test-run-scorecards"
        className="flex flex-wrap items-baseline gap-x-2 text-[15px] font-semibold"
      >
        Scorecards
        <span className="text-[13px] font-normal text-muted-foreground">
          every check, across {plural(scorecard.iterationCount, "iteration")}
        </span>
        {scorecard.timedOut > 0 ? (
          <span className="text-[13px] font-normal text-warning">
            · {scorecard.timedOut} timed out, so{" "}
            {scorecard.timedOut === 1 ? "its" : "their"} checks weren't measured
          </span>
        ) : null}
      </h3>
      {scorecard.groups.length === 0 ? (
        <p className="rounded-xl border border-border px-4 py-6 text-sm text-muted-foreground">
          No checks were measured for this test run yet.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {scorecard.groups.map((group) => (
            <div
              key={group.stage}
              className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 px-4 py-3 sm:grid-cols-[180px_minmax(0,1fr)]"
            >
              <span className="pt-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {group.label}
              </span>
              <ul className="flex flex-col gap-1.5">
                {group.rows.map((row) => {
                  const failed = row.measured > row.passed;
                  const failedIterationId = row.firstFailedIterationId;
                  return (
                    <li
                      key={row.key}
                      className="flex min-h-7 items-center gap-3 text-[13px]"
                      data-testid="test-run-scorecard-row"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          row.measured === 0
                            ? "bg-muted-foreground"
                            : failed
                              ? "bg-destructive"
                              : "bg-success",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {row.label}
                      </span>
                      {row.note ? (
                        <span className="text-[11px] text-muted-foreground">
                          {row.note}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          "w-24 shrink-0 text-right text-xs tabular-nums",
                          row.measured === 0
                            ? "text-muted-foreground"
                            : failed
                              ? "text-destructive"
                              : "text-success",
                        )}
                      >
                        {row.measured === 0
                          ? "Not measured"
                          : `${row.passed}/${row.measured} passed`}
                      </span>
                      <span className="w-7 shrink-0">
                        {failed && failedIterationId && onOpenIteration ? (
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-7"
                            aria-label={`Open an iteration that failed ${row.label}`}
                            onClick={() => onOpenIteration(failedIterationId)}
                          >
                            <ArrowUpRight className="size-3.5" aria-hidden />
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
