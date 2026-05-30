import { useMemo } from "react";
import { Copy, Loader2, RotateCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Progress } from "@mcpjam/design-system/progress";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import {
  buildFixPrompt,
  buildTopNPrompt,
  computeRunPassRatePercent,
  unifyTriageRows,
  type TriageRow,
} from "./ai-triage-helpers";
import type { EvalIteration, EvalSuiteRun } from "./types";

export interface AiTriageCardProps {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  serverQuality: EvalSuiteRun["serverQuality"] | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  onRetry: () => void;
}

const TOP_N = 3;

async function copyWithToast(text: string, successLabel: string) {
  const ok = await copyToClipboard(text);
  if (ok) {
    toast.success(successLabel);
  } else {
    toast.error("Copy failed");
  }
}

function ImpactBadge({ row }: { row: TriageRow }) {
  if (row.failureCount > 0) {
    return (
      <span className="text-xs font-medium tabular-nums text-destructive">
        −{row.failureCount} failure{row.failureCount === 1 ? "" : "s"}
      </span>
    );
  }
  if (row.source === "tool" && row.affectedCaseKeys.length === 0) {
    return (
      <span className="text-xs font-medium text-muted-foreground">
        Server-wide
      </span>
    );
  }
  return (
    <span className="text-xs font-medium text-muted-foreground">
      Inefficient
    </span>
  );
}

function CategoryChip({ row }: { row: TriageRow }) {
  return (
    <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
      {row.category}
    </span>
  );
}

function TriageRowItem({ row }: { row: TriageRow }) {
  return (
    <li className="flex items-start gap-3 border-t border-border/40 px-3 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {row.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <CategoryChip row={row} />
          {row.affectedCaseKeys.length > 0 ? (
            <span className="truncate">
              cases {row.affectedCaseKeys.join(", ")}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ImpactBadge row={row} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() =>
            copyWithToast(buildFixPrompt(row), "Fix prompt copied")
          }
        >
          <Copy className="h-3 w-3" />
          Copy
        </Button>
      </div>
    </li>
  );
}

export function AiTriageCard({
  run,
  iterations,
  serverQuality,
  pending,
  requested,
  failedGeneration,
  error,
  onRetry,
}: AiTriageCardProps) {
  const rows = useMemo(
    () => unifyTriageRows({ serverQuality, iterations }),
    [serverQuality, iterations],
  );

  const passRate = useMemo(
    () =>
      computeRunPassRatePercent({
        selectedRunDetails: run,
        caseGroupsForSelectedRun: iterations,
      }),
    [run, iterations],
  );

  const hasRows = rows.length > 0;
  // Distinguish "judge returned insights, all good/optimal" (arrays populated,
  // just filtered out) from "judge returned NO insights at all" (empty arrays —
  // usually a truncated/failed parse that fell back to summary-only). The latter
  // must NOT be reported as "all good".
  const noInsights =
    !!serverQuality &&
    (serverQuality.toolInsights?.length ?? 0) === 0 &&
    (serverQuality.workflowInsights?.length ?? 0) === 0;
  const topRows = rows.slice(0, TOP_N);

  const headerSubtitle = (() => {
    if (pending) return "Analyzing…";
    if (error || failedGeneration) return "Analysis failed";
    if (!serverQuality && requested) return "Requesting analysis…";
    if (!serverQuality) return "Run a completed suite to see triage";
    if (!hasRows) return noInsights ? "Summary only" : "All clean";
    return `${rows.length} root cause${rows.length === 1 ? "" : "s"}`;
  })();

  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            <Sparkles className="h-3 w-3" />
            AI Triage
          </Badge>
          <span className="truncate text-sm text-muted-foreground">
            {headerSubtitle}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {error || failedGeneration ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onRetry()}
            >
              <RotateCw className="h-3 w-3" />
              Retry
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={!hasRows}
            onClick={() =>
              copyWithToast(
                buildTopNPrompt(topRows),
                `Copied top ${topRows.length} prompt${topRows.length === 1 ? "" : "s"}`,
              )
            }
          >
            <Copy className="h-3 w-3" />
            Copy top {TOP_N}
          </Button>
        </div>
      </header>

      <div className="border-t border-border/50 px-3 py-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold tabular-nums">
            {passRate}
            <span className="text-xs font-normal text-muted-foreground">%</span>
          </span>
          <Progress value={passRate} className="h-2 flex-1" />
        </div>
      </div>

      <div className="border-t border-border/50">
        {pending ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Analyzing server quality…
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-sm text-destructive">{error}</div>
        ) : failedGeneration ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            We could not finish this analysis. Retry above, or open a test for
            the full trace.
          </div>
        ) : !serverQuality ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {requested
              ? "Requesting server quality analysis…"
              : "We will analyze your MCP server's tool quality and workflow efficiency here."}
          </div>
        ) : !hasRows ? (
          noInsights ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {serverQuality.summary?.trim() ||
                "The analysis produced no per-tool or per-workflow insights."}
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                No per-tool/workflow breakdown was produced — the analysis may
                have been truncated. Re-run to retry.
              </p>
            </div>
          ) : (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No actionable issues — all tools rated good and workflows optimal.
            </div>
          )
        ) : (
          <ul className="divide-y divide-border/40">
            {rows.map((row) => (
              <TriageRowItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
