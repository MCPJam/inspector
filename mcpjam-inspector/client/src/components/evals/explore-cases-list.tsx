import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  MinusCircle,
} from "lucide-react";
import { computeIterationResult } from "./pass-criteria";
import type { EvalCase, EvalIteration, SuiteAggregate } from "./types";
import { cn } from "@/lib/utils";

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "—";
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

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

function rowSummary(caseRow: EvalCase, latest: EvalIteration | undefined): string {
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

function StatusCell({
  testCaseId,
  aggregate,
  latest,
}: {
  testCaseId: string;
  aggregate: SuiteAggregate | null;
  latest: EvalIteration | undefined;
}) {
  const row = aggregate?.byCase.find((b) => b.testCaseId === testCaseId);
  const failed = row?.failed ?? 0;
  const computed = latest ? computeIterationResult(latest) : null;

  if (failed > 0 || computed === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span className="font-medium">Failed</span>
      </span>
    );
  }
  if (computed === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-500">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span className="font-medium">Pending</span>
      </span>
    );
  }
  if (computed === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <MinusCircle className="h-4 w-4 shrink-0" />
        <span className="font-medium">Cancelled</span>
      </span>
    );
  }
  if (computed === "passed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-500">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span className="font-medium">Passed</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Clock className="h-4 w-4 shrink-0" />
      <span className="font-medium">Not run</span>
    </span>
  );
}

export interface ExploreCasesListProps {
  cases: EvalCase[];
  aggregate: SuiteAggregate | null;
  iterations: EvalIteration[];
  isLoading: boolean;
  onRowClick: (testCaseId: string) => void;
}

export function ExploreCasesList({
  cases,
  aggregate,
  iterations,
  isLoading,
  onRowClick,
}: ExploreCasesListProps) {
  if (isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-xl border bg-card">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">Loading cases…</p>
        </div>
      </div>
    );
  }

  if (cases.length === 0) {
    return (
      <div className="rounded-xl border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
        No cases yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card text-card-foreground flex flex-col max-h-[min(70vh,640px)]">
      <div className="border-b px-4 py-2 shrink-0">
        <p className="text-xs text-muted-foreground">
          Open a case to review replay and history.
        </p>
      </div>
      <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
        <div className="w-[100px] shrink-0">Status</div>
        <div className="min-w-0 flex-1">Case</div>
        <div className="hidden min-w-0 flex-[1.2] sm:block">Summary</div>
        <div className="w-[88px] shrink-0 text-right">Last run</div>
      </div>
      <div className="divide-y overflow-y-auto">
        {cases.map((c) => {
          const latest = latestIterationForCase(c._id, iterations);
          return (
            <button
              key={c._id}
              type="button"
              onClick={() => onRowClick(c._id)}
              className={cn(
                "flex w-full items-start gap-4 px-4 py-2.5 text-left transition-colors",
                "hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              )}
            >
              <div className="w-[100px] shrink-0 pt-0.5">
                <StatusCell
                  testCaseId={c._id}
                  aggregate={aggregate}
                  latest={latest}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {c.title}
                </div>
                {c.isNegativeTest ? (
                  <span className="text-[10px] text-orange-500">Negative case</span>
                ) : null}
              </div>
              <div className="hidden min-w-0 flex-[1.2] sm:block">
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {rowSummary(c, latest)}
                </p>
              </div>
              <div className="w-[88px] shrink-0 text-right text-xs text-muted-foreground">
                {formatRelativeTime(latest?.updatedAt)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
