import { Loader2 } from "lucide-react";
import { computeIterationResult } from "./pass-criteria";
import type { EvalCase, EvalIteration, SuiteAggregate } from "./types";
import { cn } from "@/lib/utils";
import { evalStatusLeftBorderClasses, formatRelativeTime } from "./helpers";

function latestIterationForCase(
  testCaseId: string,
  iterations: EvalIteration[],
): EvalIteration | undefined {
  const forCase = iterations.filter((i) => i.testCaseId === testCaseId);
  if (forCase.length === 0) return undefined;
  return forCase.reduce((a, b) =>
    (a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? a : b,
  );
}

function rowSummary(
  caseRow: EvalCase,
  latest: EvalIteration | undefined,
): string {
  if (!latest) return caseRow.scenario?.slice(0, 120) || "No runs yet";
  if (latest.error) {
    const e = latest.error;
    return e.length > 100 ? `${e.slice(0, 100)}…` : e;
  }
  const computed = computeIterationResult(latest);
  if (computed === "passed") return "Passed";
  if (computed === "failed") return "Failed expectations";
  if (computed === "pending") return "Running or pending…";
  if (computed === "cancelled") return "Cancelled";
  return caseRow.scenario?.slice(0, 120) || "—";
}

function caseRowLeftBorder(
  testCaseId: string,
  aggregate: SuiteAggregate | null,
  latest: EvalIteration | undefined,
): string {
  const histRow = aggregate?.byCase.find((b) => b.testCaseId === testCaseId);
  const failedHist = histRow?.failed ?? 0;

  if (!latest) {
    if (failedHist > 0) return evalStatusLeftBorderClasses("failed");
    return "border-l-transparent";
  }

  const computed = computeIterationResult(latest);
  // Latest iteration reflects the current run; don't mix in historical failures
  // while this case is still in flight or has already passed on this latest result.
  if (computed === "pending") {
    return evalStatusLeftBorderClasses("running");
  }
  if (computed === "cancelled") {
    return evalStatusLeftBorderClasses("cancelled");
  }
  if (computed === "failed") {
    return evalStatusLeftBorderClasses("failed");
  }
  if (computed === "passed") {
    return evalStatusLeftBorderClasses("passed");
  }
  if (failedHist > 0) {
    return evalStatusLeftBorderClasses("failed");
  }
  return evalStatusLeftBorderClasses(computed);
}

function caseRowOutcomeTitle(
  testCaseId: string,
  aggregate: SuiteAggregate | null,
  latest: EvalIteration | undefined,
): string {
  const histRow = aggregate?.byCase.find((b) => b.testCaseId === testCaseId);
  const failedHist = histRow?.failed ?? 0;

  if (!latest) {
    return failedHist > 0 ? "Failed before" : "Not run yet";
  }

  const computed = computeIterationResult(latest);
  if (computed === "pending") return "Pending";
  if (computed === "cancelled") return "Cancelled";
  if (computed === "failed") return "Failed";
  if (computed === "passed") return "Passed";
  if (failedHist > 0) return "Failed";
  return "Case status";
}

export interface ExploreCasesListProps {
  cases: EvalCase[];
  aggregate: SuiteAggregate | null;
  iterations: EvalIteration[];
  isLoading: boolean;
  onRowClick: (testCaseId: string) => void;
  /** Narrow CI/Runs sidebar: single-column scroll, optional selection highlight. */
  variant?: "default" | "sidebar";
  selectedCaseId?: string | null;
}

export function ExploreCasesList({
  cases,
  aggregate,
  iterations,
  isLoading,
  onRowClick,
  variant = "default",
  selectedCaseId = null,
}: ExploreCasesListProps) {
  const isSidebar = variant === "sidebar";

  if (isLoading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center",
          isSidebar
            ? "min-h-[120px] flex-1"
            : "min-h-[200px] rounded-xl border bg-card",
        )}
      >
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">Loading cases…</p>
        </div>
      </div>
    );
  }

  if (cases.length === 0) {
    return (
      <div
        className={cn(
          "text-center text-sm text-muted-foreground",
          isSidebar ? "px-3 py-8" : "rounded-xl border bg-card px-4 py-12",
        )}
      >
        No cases yet.
      </div>
    );
  }

  if (isSidebar) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
          Cases
        </div>
        <div className="min-h-0 flex-1 divide-y overflow-y-auto">
          {cases.map((c) => {
            const latest = latestIterationForCase(c._id, iterations);
            const leftBorder = caseRowLeftBorder(c._id, aggregate, latest);
            const title = caseRowOutcomeTitle(c._id, aggregate, latest);
            const selected = selectedCaseId === c._id;
            const a11yPrefix = c.isNegativeTest ? "Negative case — " : "";
            return (
              <button
                key={c._id}
                type="button"
                title={`${a11yPrefix}${c.title}. ${title}`}
                aria-label={`${a11yPrefix}${c.title}: ${title}`}
                onClick={() => onRowClick(c._id)}
                className={cn(
                  "flex w-full items-start gap-2 border-l-2 py-2 pl-[11px] pr-3 text-left transition-colors",
                  leftBorder,
                  "hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  selected && "bg-primary/10",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {c.title}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[10px] text-muted-foreground">
                  {latest?.updatedAt
                    ? formatRelativeTime(latest.updatedAt)
                    : "—"}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-h-[min(70vh,640px)] flex-col rounded-xl border bg-card text-card-foreground">
      <div className="shrink-0 border-b px-4 py-2">
        <p className="text-xs text-muted-foreground">
          Open a case to review replay and history.
        </p>
      </div>
      <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
        <div className="min-w-0 flex-1">Case</div>
        <div className="hidden min-w-0 flex-[1.2] sm:block">Summary</div>
        <div className="w-[88px] shrink-0 text-right">Last run</div>
      </div>
      <div className="divide-y overflow-y-auto">
        {cases.map((c) => {
          const latest = latestIterationForCase(c._id, iterations);
          const leftBorder = caseRowLeftBorder(c._id, aggregate, latest);
          const title = caseRowOutcomeTitle(c._id, aggregate, latest);
          return (
            <button
              key={c._id}
              type="button"
              title={title}
              aria-label={`${c.title}: ${title}`}
              onClick={() => onRowClick(c._id)}
              className={cn(
                "flex w-full items-start gap-4 border-l-2 py-2.5 pl-[15px] pr-4 text-left transition-colors",
                leftBorder,
                "hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {c.title}
                </div>
                {c.isNegativeTest ? (
                  <span className="text-[10px] text-orange-500">
                    Negative case
                  </span>
                ) : null}
              </div>
              <div className="hidden min-w-0 flex-[1.2] sm:block">
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {rowSummary(c, latest)}
                </p>
              </div>
              <div className="w-[88px] shrink-0 text-right text-xs text-muted-foreground">
                {latest?.updatedAt
                  ? formatRelativeTime(latest.updatedAt)
                  : "—"}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
