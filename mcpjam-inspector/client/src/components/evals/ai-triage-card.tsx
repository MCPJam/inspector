import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Copy, Loader2, RotateCw, TrendingUp } from "lucide-react";
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

const COPY_FIX_PROMPT_LABEL = "Copy fix prompt";
const copyTopFixPromptsLabel = (count: number) =>
  `Copy top ${count} fix prompts`;

/** Dummy per-fix accuracy lift shown until real estimates are wired up. */
const ESTIMATED_ACCURACY_GAIN_PCT = 9;

/** Distinct tones so each applied fix reads as its own slice of the potential bar. */
const GAIN_SEGMENT_TONES = ["bg-green-800", "bg-green-700", "bg-green-600"];

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
    <li className="flex items-start gap-3 border-t border-border/40 px-3 py-2.5 pl-3.5 transition-colors first:border-t-0 hover:bg-primary/[0.03]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {row.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <CategoryChip row={row} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded-full bg-green-700/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-green-700 dark:text-green-400"
          title="Estimated accuracy improvement from applying this fix"
        >
          <TrendingUp className="h-3 w-3" aria-hidden />+
          {ESTIMATED_ACCURACY_GAIN_PCT}%
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
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

  const metricLabel = run.source === "sdk" ? "Pass rate" : "Accuracy";

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

  // Project the accuracy lift from applying the top suggested fixes. Clamp the
  // total so current + gains never exceeds 100%, then split the realized gain
  // evenly across each fix's segment of the potential bar.
  const projectedGain = hasRows
    ? Math.min(100 - passRate, topRows.length * ESTIMATED_ACCURACY_GAIN_PCT)
    : 0;
  const potentialAccuracy = passRate + projectedGain;
  const gainSegmentWidth =
    topRows.length > 0 ? projectedGain / topRows.length : 0;

  const headerSubtitle = (() => {
    if (pending) return "Analyzing…";
    if (error || failedGeneration) return "Analysis failed";
    if (!serverQuality && requested) return "Requesting analysis…";
    if (!serverQuality) return "Run a completed suite to see triage";
    if (!hasRows) return noInsights ? "Summary only" : "All clean";
    if (rows.length > TOP_N) {
      return `Top ${TOP_N} of ${rows.length} suggested fix${rows.length === 1 ? "" : "es"}`;
    }
    return `${rows.length} suggested fix${rows.length === 1 ? "" : "es"}`;
  })();

  const hasProjectedLift = projectedGain > 0;

  return (
    <section
      className={cn(
        "relative rounded-xl border text-card-foreground shadow-sm",
        "border-primary/20 bg-gradient-to-br from-primary/[0.07] via-card to-card",
        "ring-1 ring-inset ring-primary/10",
      )}
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-primary/50"
        aria-hidden
      />
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/10 bg-primary/[0.04] px-3 py-2.5 pl-3.5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
            AI Insights
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {headerSubtitle}
          </p>
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
            className="h-7 shrink-0 gap-1 text-xs"
            disabled={!hasRows}
            title={`Copy the top ${TOP_N} fix prompts to paste into your coding agent`}
            aria-label={copyTopFixPromptsLabel(TOP_N)}
            onClick={() =>
              copyWithToast(
                buildTopNPrompt(topRows),
                `Copied ${topRows.length} fix prompt${topRows.length === 1 ? "" : "s"} — paste into your agent`,
              )
            }
          >
            <Copy className="h-3 w-3" aria-hidden />
            {copyTopFixPromptsLabel(TOP_N)}
          </Button>
        </div>
      </header>

      <div
        className={cn(
          "border-t border-border/40 px-3 py-3 pl-3.5",
          hasProjectedLift && "bg-green-700/[0.04] dark:bg-green-400/[0.06]",
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className={runDetailSectionLabelClass}>
            {hasProjectedLift
              ? `Potential ${metricLabel.toLowerCase()}`
              : metricLabel}
          </span>
          <span className="tabular-nums">
            {passFailStats.passed} passed · {passFailStats.failed} failed
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-metric text-xl font-semibold tabular-nums leading-none">
            {passRate}
            <span className="text-sm font-medium text-muted-foreground">%</span>
          </span>
          {projectedGain > 0 ? (
            <>
              <ArrowRight
                className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground"
                aria-hidden
              />
              <span className="font-metric text-xl font-semibold tabular-nums leading-none text-green-700 dark:text-green-400">
                {potentialAccuracy}
                <span className="text-sm font-medium text-green-700/70 dark:text-green-400/70">
                  %
                </span>
              </span>
              <span className="text-xs font-medium text-green-700 dark:text-green-400">
                +{projectedGain}% with top {topRows.length} fix
                {topRows.length === 1 ? "" : "es"}
              </span>
            </>
          ) : null}
        </div>
        <div
          className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={
            projectedGain > 0
              ? `Current ${metricLabel.toLowerCase()} ${passRate}%, projected ${potentialAccuracy}% after applying the top ${topRows.length} fixes`
              : `${metricLabel} ${passRate}%`
          }
        >
          <div
            className="h-full bg-primary"
            style={{ width: `${passRate}%` }}
            title={`Current ${metricLabel.toLowerCase()}: ${passRate}%`}
          />
          {projectedGain > 0
            ? topRows.map((row, idx) => (
                <div
                  key={row.id}
                  className={cn(
                    "h-full border-l border-card",
                    GAIN_SEGMENT_TONES[idx % GAIN_SEGMENT_TONES.length],
                  )}
                  style={{ width: `${gainSegmentWidth}%` }}
                  title={`${row.title}: +${ESTIMATED_ACCURACY_GAIN_PCT}%`}
                />
              ))
            : null}
        </div>
        {hasProjectedLift ? (
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            Apply the top {topRows.length} suggested fix
            {topRows.length === 1 ? "" : "es"} to reach an estimated{" "}
            <span className="font-medium text-green-700 dark:text-green-400">
              {potentialAccuracy}%
            </span>{" "}
            {metricLabel.toLowerCase()}.
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          "border-t border-border/40 bg-card/40",
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
          <>
            <ul className="divide-y divide-border/40">
              {visibleRows.map((row) => (
                <TriageRowItem key={row.id} row={row} />
              ))}
            </ul>
            {hasMoreSuggestions ? (
              <button
                type="button"
                className="w-full border-t border-border/40 py-2 text-xs font-medium text-primary transition-colors hover:bg-muted/50"
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
