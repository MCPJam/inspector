import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, RotateCw } from "lucide-react";
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
  /** Flush layout inside the run-detail split (no nested card chrome). */
  embedded?: boolean;
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
  const label = row.category === "tool description" ? "Tool" : "Workflow";
  return (
    <span className="inline-flex whitespace-nowrap rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}

function TriageRowItem({ row }: { row: TriageRow }) {
  return (
    <li className="group px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-foreground">{row.title}</p>
          <div className="mt-1">
            <CategoryChip row={row} />
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 px-0 text-muted-foreground opacity-70 hover:text-foreground group-hover:opacity-100"
          title={`Copy a fix prompt for your coding agent (${row.title})`}
          aria-label={`${COPY_FIX_PROMPT_LABEL}: ${row.title}`}
          onClick={() =>
            copyWithToast(
              buildFixPrompt(row),
              "Fix prompt copied — paste into your agent",
            )
          }
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
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
  embedded = false,
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

  // Host attribution: the snapshot persisted with the analysis is authoritative
  // (it reflects the run's pinned config). Fall back to the run's named-host id
  // only as a label when no analysis snapshot exists yet.
  const host = serverQuality?.host;
  const hostLabel = (() => {
    if (!host || host.source === "unknown") return null;
    const name = host.name ?? "Host";
    return host.modelId ? `${name} · ${host.modelId}` : name;
  })();

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
    if (embedded) {
      if (rows.length > TOP_N) {
        return `Showing top ${TOP_N} of ${rows.length}`;
      }
      return null;
    }
    if (rows.length > TOP_N) {
      return `Top ${TOP_N} of ${rows.length} suggested fix${rows.length === 1 ? "" : "es"}`;
    }
    return `${rows.length} suggested fix${rows.length === 1 ? "" : "es"}`;
  })();

  const sectionTitle = embedded ? "Suggested fixes" : "Server quality";
  const showAccuracyBlock = !embedded;

  const copyAllButton = hasRows ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 shrink-0 gap-1 text-xs text-muted-foreground hover:text-foreground",
        embedded ? "px-2" : "gap-1.5",
      )}
      disabled={pending}
      title={`Copy the top ${topRows.length} fix prompt${topRows.length === 1 ? "" : "s"} to paste into your coding agent`}
      aria-label={copyTopFixPromptsLabel(topRows.length)}
      onClick={() =>
        copyWithToast(
          buildTopNPrompt(topRows),
          `Copied ${topRows.length} fix prompt${topRows.length === 1 ? "" : "s"} — paste into your agent`,
        )
      }
    >
      <Copy className="h-3 w-3 shrink-0" aria-hidden />
      {embedded ? (
        <span>Copy top {topRows.length}</span>
      ) : (
        <span className="truncate">{copyTopFixPromptsLabel(topRows.length)}</span>
      )}
    </Button>
  ) : null;

  const statusBody = (
    <>
      {pending ? (
        <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Analyzing server quality…
        </div>
      ) : error ? (
        <div className="px-3 py-3 text-sm text-destructive">{error}</div>
      ) : failedGeneration ? (
        <div className="px-3 py-3 text-sm text-muted-foreground">
          We could not finish this analysis. Retry above, or open a test for the
          full trace.
        </div>
      ) : !serverQuality ? (
        <div className="px-3 py-3 text-sm text-muted-foreground">
          {requested
            ? "Requesting server quality analysis…"
            : "Tool and workflow suggestions will appear here after analysis."}
        </div>
      ) : !hasRows ? (
        noInsights ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            {serverQuality.summary?.trim() ||
              "The analysis produced no per-tool or per-workflow insights."}
            <p className="mt-1 text-xs text-warning">
              No per-tool/workflow breakdown was produced — the analysis may
              have been truncated. Re-run to retry.
            </p>
          </div>
        ) : (
          <div className="px-3 py-3 text-sm text-muted-foreground">
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
              className="w-full border-t border-border/40 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
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
    </>
  );

  return (
    <section
      className={cn(
        "flex flex-col text-card-foreground",
        embedded
          ? "bg-transparent"
          : "rounded-lg border border-border bg-card",
      )}
    >
      <header
        className={cn(
          "flex flex-col gap-2",
          embedded ? "px-3 py-2" : "px-3 py-2.5",
        )}
      >
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">{sectionTitle}</h3>
            {headerSubtitle ? (
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                {headerSubtitle}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
            {copyAllButton}
          </div>
        </div>
        {!embedded && hostLabel ? (
          <p
            className="truncate font-mono text-[11px] leading-snug text-muted-foreground"
            title={hostLabel}
          >
            {hostLabel}
          </p>
        ) : null}
      </header>

      {showAccuracyBlock ? (
        <div className="border-t border-border/50 px-3 py-2.5">
          <div className="flex flex-col gap-1">
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
      ) : null}

      <div
        className={cn(
          "border-t border-border/40",
          hasRows && "max-h-[min(50vh,24rem)] overflow-y-auto overscroll-y-contain",
        )}
      >
        {statusBody}
      </div>

      {embedded && hostLabel ? (
        <p
          className="border-t border-border/40 px-3 py-1.5 font-mono text-[10px] text-muted-foreground/80"
          title={hostLabel}
        >
          {hostLabel}
        </p>
      ) : null}
    </section>
  );
}
