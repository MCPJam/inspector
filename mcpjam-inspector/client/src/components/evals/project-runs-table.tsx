import { useMemo, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { GitBranch, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import { formatDuration, formatRunId, formatTime } from "./helpers";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { RunSourceBadge } from "./run-source-badge";
import type { EvalSuiteRun } from "./types";
import { RunDecisionVerdictBadge } from "./run-decision-summary-card";
import {
  useEvalRunDecisionBadge,
  useHasBeenVisible,
} from "@/hooks/use-eval-run-decision-summary";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import {
  decisionMeasurementUnitLabel,
  formatDecisionCounts,
} from "./run-decision-summary-presentation";

export const PROJECT_RUNS_PAGE_SIZE = 50;

/**
 * One row of `testSuites:listProjectRuns` — the backend's explicit
 * projection, not a run Doc. Deliberately mirrored here field-for-field
 * rather than derived from `EvalSuiteRun`: the query never returns the heavy
 * snapshot fields, and typing this as a partial run would invite a reader to
 * reach for one.
 */
export interface ProjectRunRow {
  _id: string;
  suiteId: string;
  suiteName: string | null;
  suiteSource: "ui" | "sdk" | null;
  runNumber: number;
  status: EvalSuiteRun["status"];
  result: EvalSuiteRun["result"];
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  } | null;
  source: EvalSuiteRun["source"] | null;
  ciMetadata: EvalSuiteRun["ciMetadata"] | null;
  createdBy: string;
  createdByName: string | null;
  createdByImageUrl: string | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
}

const SOURCE_FILTERS: Array<{
  value: NonNullable<EvalSuiteRun["source"]>;
  label: string;
}> = [
  { value: "sdk", label: "SDK" },
  { value: "ui", label: "UI" },
  { value: "api", label: "API" },
  { value: "schedule", label: "Scheduled" },
  { value: "github_check", label: "GitHub" },
];

const ALL_SUITES = "__all__";

function statusMeta(row: ProjectRunRow): {
  label: string;
  className: string;
} {
  if (row.status === "running" || row.status === "pending") {
    return { label: "Running", className: "bg-warning/50 text-foreground" };
  }
  // Status is the fallback, not just a running/pending check: a run that died
  // before finalize is `status: "failed"` while `result` still reads
  // `"pending"`, and reporting that as "Pending" describes a run as
  // in-progress when it is over and it lost.
  const effective =
    row.result && row.result !== "pending" ? row.result : row.status;
  switch (effective) {
    case "passed":
      return { label: "Passed", className: "bg-success/50 text-foreground" };
    case "failed":
      return {
        label: "Failed",
        className: "bg-destructive/50 text-foreground",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        className: "bg-muted text-muted-foreground",
      };
    case "timed_out":
      return { label: "Timed out", className: "bg-warning/50 text-foreground" };
    default:
      return { label: "Pending", className: "bg-muted text-muted-foreground" };
  }
}

/**
 * Pass rate reads as "Pass rate" for SDK/CI runs and "Accuracy" everywhere
 * else — the same split `getRunMetricSource` encodes, applied per row since
 * this table mixes origins. Legacy rows with no `source` fall back to the
 * suite's creation provenance, which the query already resolved.
 */
function metricLabel(row: ProjectRunRow): string {
  return (row.source ?? row.suiteSource) === "sdk" ? "Pass rate" : "Accuracy";
}

/**
 * The project-wide runs feed: EVERY run in the project in one list, with
 * origin as a per-row badge rather than as a separate surface.
 *
 * This is the answer to "what has run lately", which until now had no home:
 * a run was only visible inside its own suite, or in the sdk-only commit
 * rail. The sidebar stays CI-flavored on purpose (see `CiEvalsTab`) — this
 * panel is the surface that shows everything.
 *
 * Filters are CLIENT-SIDE over the loaded pages, not query args. Pushing
 * them into the query would mean either a composite index per filter
 * combination or an unbounded scan behind a `.filter()`, and the honest
 * alternative — telling the reader what they are filtering over — costs one
 * line of copy.
 */
export function ProjectRunsTable({
  projectId,
  onSelectRun,
  decisionSummaryEnabled = false,
}: {
  projectId: string;
  onSelectRun: (args: { suiteId: string; runId: string }) => void;
  /**
   * Read D9's canonical verdict and counts for terminal rows, one row at a
   * time as it scrolls into view.
   *
   * OFF by default — only Evaluate opts in — and off means off: no
   * subscription, no request, and the table renders exactly as it does today.
   */
  decisionSummaryEnabled?: boolean;
}) {
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());
  const [suiteFilter, setSuiteFilter] = useState<string>(ALL_SUITES);

  const { results, status, loadMore } = usePaginatedQuery(
    "testSuites:listProjectRuns" as any,
    { projectId } as any,
    { initialNumItems: PROJECT_RUNS_PAGE_SIZE },
  );

  const rows = results as ProjectRunRow[];

  const suiteOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) {
      if (!byId.has(row.suiteId)) {
        byId.set(row.suiteId, row.suiteName ?? formatRunId(row.suiteId));
      }
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (suiteFilter !== ALL_SUITES && row.suiteId !== suiteFilter) {
          return false;
        }
        if (sourceFilter.size === 0) return true;
        return sourceFilter.has(row.source ?? "ui");
      }),
    [rows, sourceFilter, suiteFilter],
  );

  const isLoadingFirstPage = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const isFiltering = sourceFilter.size > 0 || suiteFilter !== ALL_SUITES;

  const toggleSource = (value: string) => {
    setSourceFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  if (isLoadingFirstPage) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="mx-auto max-w-md p-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <GitBranch className="h-7 w-7 text-muted-foreground" />
          </div>
          <h2 className="mb-2 text-lg font-semibold text-foreground">
            No runs yet
          </h2>
          <p className="text-sm text-muted-foreground">
            Runs from the SDK, the app, schedules, and GitHub checks all land
            here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-6 pb-6 pt-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Source
        </span>
        {SOURCE_FILTERS.map((filter) => {
          const active = sourceFilter.has(filter.value);
          return (
            <button
              key={filter.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggleSource(filter.value)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                active
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border/60 bg-transparent text-muted-foreground hover:bg-muted/50",
              )}
            >
              {filter.label}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Suite
          </span>
          <Select value={suiteFilter} onValueChange={setSuiteFilter}>
            <SelectTrigger
              aria-label="Filter by suite"
              className="h-8 w-[200px] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SUITES}>All suites</SelectItem>
              {suiteOptions.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/*
        Say what the filters actually cover. They run over the pages loaded
        so far, so with more pages outstanding "no SDK runs" would otherwise
        read as a fact about the project rather than about this page.
      */}
      {isFiltering && canLoadMore ? (
        <p className="text-[11px] text-muted-foreground">
          Filtering the {rows.length} most recent runs loaded so far — load more
          below to widen the search.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/60">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-[110px]">Run</TableHead>
              <TableHead>Suite</TableHead>
              <TableHead className="w-[90px]">Source</TableHead>
              <TableHead className="w-[100px]">Result</TableHead>
              {/*
                Neutral, because the metric is per ROW here. A single "Pass
                rate" header would mislabel every non-SDK row: `metricLabel`
                calls those "Accuracy" (per-iteration) rather than pass rate
                (per-case), and this table is the one surface that mixes both.
              */}
              <TableHead className="w-[150px]">Metric</TableHead>
              <TableHead className="w-[170px]">Started</TableHead>
              <TableHead className="w-[90px]">Duration</TableHead>
              <TableHead className="w-[140px]">Run by</TableHead>
              <TableHead className="w-[180px]">CI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  No runs match these filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((row) => (
                <ProjectRunTableRow
                  key={row._id}
                  row={row}
                  projectId={projectId}
                  decisionSummaryEnabled={decisionSummaryEnabled}
                  onSelectRun={onSelectRun}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {canLoadMore ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadMore(PROJECT_RUNS_PAGE_SIZE)}
          >
            Load more
          </Button>
        </div>
      ) : status === "LoadingMore" ? (
        <div className="flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One run row, with its canonical verdict read lazily.
 *
 * Extracted into its own component for two reasons that are really the same
 * reason: a hook cannot live inside a `.map()` callback, and the per-row read
 * has to be able to say "not yet" — which is what
 * {@link useHasBeenVisible} gives it. A 50-row page therefore paints without
 * 50 requests, and "Load more" adds rows that cost nothing until someone
 * scrolls to them.
 *
 * A RUNNING row stays lifecycle-only: `statusMeta` describes where the run is,
 * which is all there is to say about a run that has not decided anything. And
 * a row whose summary has not arrived keeps the stored `summary` numbers it
 * always showed — this never invents an aggregate for a row it could not read,
 * including the fan-out rows whose stored numbers describe one leg.
 */
function ProjectRunTableRow({
  row,
  projectId,
  decisionSummaryEnabled,
  onSelectRun,
}: {
  row: ProjectRunRow;
  projectId: string;
  decisionSummaryEnabled: boolean;
  onSelectRun: (args: { suiteId: string; runId: string }) => void;
}) {
  const [visibilityRef, hasBeenVisible] = useHasBeenVisible<HTMLTableRowElement>();
  const terminal = isTerminalEvalRunStatus(row.status);
  const { summary } = useEvalRunDecisionBadge({
    projectId,
    runId: row._id,
    enabled: decisionSummaryEnabled && terminal && hasBeenVisible,
    revision: evalRunDecisionRevision(row),
  });

  const meta = statusMeta(row);
  // Run detail is rendered inside its suite, so a row whose suite no longer
  // resolves has nowhere to go — presenting it as clickable would promise a
  // navigation that bounces straight back here. Show the row (the run
  // happened) but don't pretend it opens.
  const canOpen = row.suiteName !== null;
  const open = () => onSelectRun({ suiteId: row.suiteId, runId: row._id });

  const canonicalCounts = summary ? formatDecisionCounts(summary.counts) : null;
  const canonicalUnit = summary
    ? decisionMeasurementUnitLabel(summary.counts)
    : null;

  return (
    <TableRow
      ref={decisionSummaryEnabled ? visibilityRef : undefined}
      {...(canOpen
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Run ${formatRunId(row._id)}`,
            onClick: open,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
              }
            },
          }
        : {})}
      className={canOpen ? "cursor-pointer" : undefined}
    >
      <TableCell className="font-mono text-xs">{formatRunId(row._id)}</TableCell>
      <TableCell className="max-w-[220px] truncate text-xs">
        {row.suiteName ?? (
          <span
            className="text-muted-foreground"
            title="This run's suite no longer exists, so its detail view can't be opened."
          >
            Deleted suite
          </span>
        )}
      </TableCell>
      <TableCell>
        <RunSourceBadge source={row.source ?? undefined} />
      </TableCell>
      <TableCell>
        {summary ? (
          // The run's own verdict replaces the status-derived label outright,
          // `inconclusive` and "no verdict" included — those are answers this
          // column could not previously express at all.
          <RunDecisionVerdictBadge summary={summary} />
        ) : (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              meta.className,
            )}
          >
            {meta.label}
          </span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {canonicalCounts ? (
          <span className="flex flex-col leading-tight">
            <span>{canonicalCounts}</span>
            {/*
              Rendered, not a `title`: which population this number counts has
              to be readable, and a tooltip is invisible to anyone scanning the
              column or using a screen reader.
            */}
            <span className="text-[10px] opacity-70">
              {canonicalUnit ? `counted in ${canonicalUnit}` : null}
            </span>
          </span>
        ) : row.summary ? (
          <span className="flex flex-col leading-tight">
            <span>
              {Math.round(row.summary.passRate)}%{" "}
              <span className="text-[10px]">
                ({row.summary.passed}/{row.summary.total})
              </span>
            </span>
            <span className="text-[10px] opacity-70">{metricLabel(row)}</span>
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatTime(row.createdAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.durationMs != null ? formatDuration(row.durationMs) : "—"}
      </TableCell>
      <TableCell className="max-w-[140px] truncate text-xs text-muted-foreground">
        {row.createdByName ?? "—"}
      </TableCell>
      <TableCell>
        {row.ciMetadata ? (
          <CiMetadataDisplay
            ciMetadata={row.ciMetadata}
            compact
            compactMode="chip"
            interactive={false}
          />
        ) : null}
      </TableCell>
    </TableRow>
  );
}
