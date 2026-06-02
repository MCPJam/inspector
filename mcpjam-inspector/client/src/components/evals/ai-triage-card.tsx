import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, RotateCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import {
  buildFixPrompt,
  buildTopNPrompt,
  computeRunPassFailStats,
  computeRunPassRatePercent,
  unifyTriageRows,
  type TriageRow,
} from "./ai-triage-helpers";
import { runDetailSectionLabelClass } from "./run-detail-typography";
import {
  passRateColorClass,
  passRateSegmentColorClass,
} from "./suite-overview-presentation";
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
  source?: "ui" | "sdk";
}

const TOP_N = 3;

const COPY_FIX_PROMPT_LABEL = "Copy fix prompt";
const copyTopFixPromptsLabel = (count: number) =>
  `Copy top ${count} fix prompts`;

async function copyWithToast(text: string, successLabel: string) {
  const ok = await copyToClipboard(text);
  if (ok) {
    toast.success(successLabel);
  } else {
    toast.error("Copy failed");
  }
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
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{row.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <CategoryChip row={row} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
          title={`Copy a fix prompt for your coding agent (${row.title})`}
          aria-label={`${COPY_FIX_PROMPT_LABEL}: ${row.title}`}
          onClick={() =>
            copyWithToast(buildFixPrompt(row), "Fix prompt copied — paste into your agent")
          }
        >
          <Copy className="h-3 w-3" aria-hidden />
          {COPY_FIX_PROMPT_LABEL}
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
  source,
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

  const passFailStats = useMemo(
    () =>
      computeRunPassFailStats({
        selectedRunDetails: run,
        caseGroupsForSelectedRun: iterations,
      }),
    [run, iterations],
  );

  const metricLabel =
    (source ?? run.source) === "sdk" ? "Pass Rate" : "Accuracy";

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
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  useEffect(() => {
    setShowAllSuggestions(false);
  }, [run._id, serverQuality?.generatedAt]);

  const visibleRows = showAllSuggestions ? rows : topRows;
  const hasMoreSuggestions = rows.length > TOP_N;

  const headerSubtitle = (() => {
    if (pending) return "Analyzing…";
    if (error || failedGeneration) return "Analysis failed";
    if (!serverQuality && requested) return "Requesting analysis…";
    if (!serverQuality) return "Waiting for analysis…";
    if (!hasRows) return noInsights ? "Summary only" : "All clean";
    if (rows.length > TOP_N) {
      return `Top ${TOP_N} of ${rows.length} suggested fix${rows.length === 1 ? "" : "es"}`;
    }
    return `${rows.length} suggested fix${rows.length === 1 ? "" : "es"}`;
  })();

  return (
    <section className="rounded-lg border border-border bg-card text-card-foreground">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            AI insights
          </span>
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
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 text-xs text-muted-foreground hover:text-foreground"
            disabled={!hasRows || pending}
            title={`Copy the top ${topRows.length} fix prompt${topRows.length === 1 ? "" : "s"} to paste into your coding agent`}
            aria-label={copyTopFixPromptsLabel(topRows.length)}
            onClick={() =>
              copyWithToast(
                buildTopNPrompt(topRows),
                `Copied ${topRows.length} fix prompt${topRows.length === 1 ? "" : "s"} — paste into your agent`,
              )
            }
          >
            <Copy className="h-3 w-3" aria-hidden />
            {copyTopFixPromptsLabel(topRows.length)}
          </Button>
        </div>
      </header>

      <div className="border-t border-border/50 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className={runDetailSectionLabelClass}>{metricLabel}</span>
            <span
              className={cn(
                "text-sm tabular-nums",
                passFailStats.total === 0
                  ? "text-muted-foreground"
                  : passRateColorClass(passRate),
              )}
            >
              {passFailStats.total === 0 ? "—" : `${passRate}%`}
            </span>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {passFailStats.total === 0
              ? "No cases recorded yet"
              : `${passFailStats.passed} passed · ${passFailStats.failed} failed`}
          </span>
        </div>
        <div
          className="mt-2 flex h-1 w-full overflow-hidden rounded-full bg-muted/60"
          role="img"
          aria-label={
            passFailStats.total === 0
              ? `${metricLabel} not yet measured`
              : `${metricLabel} ${passRate}%`
          }
        >
          {passFailStats.total === 0 ? null : (
            <div
              className={cn("h-full", passRateSegmentColorClass(passRate))}
              style={{ width: `${passRate}%` }}
              title={`${metricLabel}: ${passRate}%`}
            />
          )}
        </div>
      </div>

      <div
        className={cn(
          "border-t border-border/50",
          hasRows && "max-h-[min(50vh,24rem)] overflow-y-auto overscroll-y-contain",
        )}
      >
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
              <p className="mt-1 text-xs text-warning">
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
          <>
            <ul className="divide-y divide-border/50">
              {visibleRows.map((row) => (
                <TriageRowItem key={row.id} row={row} />
              ))}
            </ul>
            {hasMoreSuggestions ? (
              <button
                type="button"
                className="w-full border-t border-border/50 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                aria-expanded={showAllSuggestions}
                onClick={() => setShowAllSuggestions((v) => !v)}
              >
                {showAllSuggestions
                  ? "Show less"
                  : `Show ${rows.length - TOP_N} more`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
