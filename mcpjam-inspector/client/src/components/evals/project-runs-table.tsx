import { Skeleton } from "@mcpjam/design-system/skeleton";
import { Input } from "@mcpjam/design-system/input";
import {
  readRunGitMetadata,
  RunBranchCell,
  RunCommitCell,
  RunPullRequestCell,
  RunPlatformBadge,
} from "./run-git-metadata";
import { EvalListFilter, ALL_EVAL_FILTER_VALUES } from "./eval-list-filter";
import {
  buildRunPassRateChanges,
  type RunPassRateChange,
} from "./run-pass-rate-changes";
import { useProjectRunHistory } from "./use-project-run-history";
import { MetricStrip } from "./metric-strip";
import {
  buildSuiteMetricStripData,
  buildAggregateMetricStripData,
  type MetricStripData,
} from "./metric-strip-data";
import {
  buildSuiteRunHistoryRows,
  formatRunHistoryDate,
  formatRunHistoryMetric,
  type SuiteRunHistoryRow,
} from "../evaluate/suite-detail-model";
import { resultCounts } from "../evaluate/run-results-matrix-model";
import { RunClientsCell } from "./run-clients-cell";
import {
  groupProjectRuns,
  projectRunRollup,
  ProjectRunSuiteGroup,
} from "./project-run-suite-groups";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  RunHistoryTable,
  RunHistorySummary,
  RunHistoryStat,
  runHistorySurfaceClass,
  runHistoryToolbarClass,
  runHistoryFilterClass,
  runHistoryFooterClass,
} from "./run-history-table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@mcpjam/design-system/dropdown-menu";
import { useMemo, useState, type ReactNode } from "react";
import { usePaginatedQuery } from "convex/react";
import { ChevronDown, GitBranch, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
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
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import { formatDuration, formatRunId, formatTime } from "./helpers";
import { CiMetadataDisplay } from "./ci-metadata-display";
import {
  apiKeyTail,
  originsForFilters,
  runAgentName,
  RUN_ORIGIN_FILTERS,
  resolveRunOrigin,
} from "@/lib/evals/run-origin";
import type { EvalSuiteRun } from "./types";
import {
  RunDecisionVerdictBadge,
  RunDecisionVerdictUnavailable,
} from "./run-decision-summary-card";
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
  /**
   * The DECLARED launcher and the VERIFIED attribution. Both `| null` AND
   * optional: a backend that predates run provenance sends neither key, so a
   * reader that assumed the field existed would crash the whole table against
   * an older deployment.
   */
  launcher?: EvalSuiteRun["launcher"] | null;
  attribution?: EvalSuiteRun["attribution"] | null;
  ciMetadata: EvalSuiteRun["ciMetadata"] | null;
  createdBy: string;
  createdByName: string | null;
  createdByImageUrl: string | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
}

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
    case "grading":
      // A held run's `result` is the truthy "pending", so the fallback above
      // routes it here by STATUS — which is what stops it reading as a queued
      // run when its verdict is minutes away.
      return { label: "Grading", className: "bg-warning/50 text-foreground" };
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

export function isGithubRun(row: ProjectRunRow): boolean {
  const origin = resolveRunOrigin(row);
  return origin === "github_check" || origin === "github_action";
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
  embedded = false,
  historyMetricsEnabled = false,
  metricBars = false,
  emptyState,
}: {
  projectId: string;
  historyMetricsEnabled?: boolean;
  metricBars?: boolean;
  /** Use the parent page scroll when shown below the suite cards. */
  embedded?: boolean;
  /**
   * First-run empty. Evaluate shares the Suites hero here so a project
   * that has never run does not grow a second empty.
   */
  emptyState?: ReactNode;
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
  const [suiteExpansion, setSuiteExpansion] = useState<Map<string, boolean>>(
    new Map(),
  );
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());
  const [suiteFilter, setSuiteFilter] = useState<string>(ALL_SUITES);
  const [clientFilter, setClientFilter] = useState(ALL_EVAL_FILTER_VALUES);
  const [serverFilter, setServerFilter] = useState(ALL_EVAL_FILTER_VALUES);
  const [repositoryFilter, setRepositoryFilter] = useState(
    ALL_EVAL_FILTER_VALUES,
  );
  const [branchFilter, setBranchFilter] = useState(ALL_EVAL_FILTER_VALUES);
  const [commitFilter, setCommitFilter] = useState("");

  // Legacy feeds support a server-side origins query. Evaluate history keeps
  // its query stable: some deployed backends reject that optional argument.
  // Filter loaded rows locally and retain pagination for older matches.
  const origins = useMemo(
    () => originsForFilters([...sourceFilter]),
    [sourceFilter],
  );

  const { results, status, loadMore } = usePaginatedQuery(
    "testSuites:listProjectRuns" as any,
    {
      projectId,
      ...(!historyMetricsEnabled && origins.length > 0 ? { origins } : {}),
    } as any,
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

  const sourceAndSuiteRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          (suiteFilter === ALL_SUITES || row.suiteId === suiteFilter) &&
          (!historyMetricsEnabled ||
            origins.length === 0 ||
            // Resolve the DISPLAYED origin (verified attribution, then the
            // declared launcher, then the stamp) so a chip matches the badge.
            origins.includes(
              (resolveRunOrigin(row) ?? "ui") as (typeof origins)[number],
            )),
      ),
    [rows, suiteFilter, historyMetricsEnabled, origins],
  );

  // Hydrate loaded history before display filters: options and comparison baselines
  // must not disappear when another row is hidden.
  const history = useProjectRunHistory(projectId, rows, historyMetricsEnabled);
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const { hosts } = useHostList({
    isAuthenticated: historyMetricsEnabled,
    projectId,
  });
  // Derived once per data/filter change, not per render. The chain below
  // groups every loaded run and builds a metric point per launch; re-running
  // it on each keystroke in the commit filter, and on the 15-second refresh
  // of active runs, also handed the child rows fresh Map identities that
  // defeated their own memoization.
  const {
    historyRows,
    clientOptions,
    serverOptions,
    repositoryOptions,
    branchOptions,
    hasGitFilter,
    showGitContext,
    filtered,
    suiteGroups,
    launches,
    metricData,
    passRateChanges,
    loadedRunCount,
  } = useMemo(() => {
    const hostNamesById = new Map(
      hosts.map((host) => [host.hostId, host.name]),
    );
    const historyRuns = [...history.details.values()].map(
      (detail) => detail.run,
    );
    const historyIterations = [...history.details.values()].flatMap(
      (detail) => detail.iterations,
    );
    const historyRows = new Map(
      buildSuiteRunHistoryRows(
        historyRuns,
        historyIterations,
        {},
        hostNamesById,
        projectEnvironmentsEnabled,
      ).map((row) => {
        const iterations = history.details.get(row.runId)?.iterations ?? [];
        return [
          row.runId,
          iterations.length
            ? {
                ...row,
                passRate: Math.round(
                  (resultCounts(iterations).passed / iterations.length) * 100,
                ),
              }
            : row,
        ];
      }),
    );
    const runServers = new Map(
      [...history.details].map(([id, detail]) => [
        id,
        detail.run.configSnapshot?.environment?.servers ?? [],
      ]),
    );
    const clientOptions = [
      ...new Set(
        [...historyRows.values()].flatMap((row) =>
          row.client ? [row.client] : [],
        ),
      ),
    ].sort();
    const serverOptions = [...new Set([...runServers.values()].flat())].sort();
    const gitByRunId = new Map(
      rows.map((row) => [
        row._id,
        isGithubRun(row) ? readRunGitMetadata(row.ciMetadata) : null,
      ]),
    );
    const repositoryOptions = [
      ...new Set(
        [...gitByRunId.values()].flatMap((git) =>
          git?.repository ? [git.repository] : [],
        ),
      ),
    ].sort();
    const branchOptions = [
      ...new Set(
        [...gitByRunId.values()].flatMap((git) =>
          git?.branch ? [git.branch] : [],
        ),
      ),
    ].sort();
    const hasGitFilter =
      repositoryFilter !== ALL_EVAL_FILTER_VALUES ||
      branchFilter !== ALL_EVAL_FILTER_VALUES ||
      Boolean(commitFilter.trim());
    const showGitContext = sourceFilter.has("github");
    const matching = sourceAndSuiteRows.filter(
      (row) =>
        (clientFilter === ALL_EVAL_FILTER_VALUES ||
          historyRows.get(row._id)?.client === clientFilter) &&
        (serverFilter === ALL_EVAL_FILTER_VALUES ||
          runServers.get(row._id)?.includes(serverFilter)) &&
        (repositoryFilter === ALL_EVAL_FILTER_VALUES ||
          gitByRunId.get(row._id)?.repository === repositoryFilter) &&
        (branchFilter === ALL_EVAL_FILTER_VALUES ||
          gitByRunId.get(row._id)?.branch === branchFilter) &&
        (!commitFilter.trim() ||
          gitByRunId
            .get(row._id)
            ?.commitSha?.toLowerCase()
            .startsWith(commitFilter.trim().toLowerCase())),
    );
    const matchingIds = new Set(matching.map((row) => row._id));
    const allSuiteGroups = groupProjectRuns(rows, history.details);
    // Filters select complete runs, never an individual execution within one.
    const filtered = historyMetricsEnabled
      ? allSuiteGroups.flatMap((suite) =>
          suite.launches
            .filter((launch) =>
              launch.runs.some((row) => matchingIds.has(row._id)),
            )
            .flatMap((launch) => launch.runs),
        )
      : matching;
    const suiteGroups = groupProjectRuns(filtered, history.details);
    const launches = suiteGroups
      .flatMap((suite) => suite.launches)
      .sort((a, b) => a.runs[0].createdAt - b.runs[0].createdAt);
    const measuredLaunches = launches.flatMap((launch) => {
      if (launch.runs.some((row) => !history.details.has(row._id))) return [];
      const runs = launch.runs.map((row) => history.details.get(row._id)!.run);
      const measured = runs.flatMap(
        (run) => history.details.get(run._id)?.iterations ?? [],
      );
      // Only this launch's iterations: both builders filter by run id, so
      // handing them the whole history made every launch rescan everything.
      const data =
        runs.length === 1
          ? buildSuiteMetricStripData(runs, measured)
          : buildAggregateMetricStripData(runs, measured);
      const counts = resultCounts(measured);
      return data
        ? [
            {
              point: measured.length
                ? {
                    ...data.latest,
                    passed: counts.passed,
                    failed: counts.failed,
                    total: measured.length,
                    passRate: Math.round(
                      (counts.passed / measured.length) * 100,
                    ),
                  }
                : data.latest,
              label: `${
                launch.runs[0].suiteName ?? "Deleted suite"
              } · #${Math.min(...runs.map((run) => run.runNumber))}`,
            },
          ]
        : [];
    });
    const series = measuredLaunches.map((launch) => launch.point);
    const metricData: MetricStripData | null = series.length
      ? {
          latest: series[series.length - 1],
          series,
          delta:
            series.length > 1
              ? series[series.length - 1].passRate -
                series[series.length - 2].passRate
              : null,
          showTrend: series.length > 1,
          runLabels: measuredLaunches.map((launch) => launch.label),
        }
      : null;
    const comparisonRows = new Map(historyRows);
    const completeRuns = allSuiteGroups.flatMap((suite) =>
      suite.launches.map((launch) => {
        const representative = [...launch.runs].sort(
          (a, b) => a.runNumber - b.runNumber || a._id.localeCompare(b._id),
        )[0];
        const metrics = projectRunRollup(launch.runs, history.details);
        const historyRow = historyRows.get(representative._id);
        if (historyRow)
          comparisonRows.set(representative._id, {
            ...historyRow,
            passRate: metrics?.passRate ?? null,
          });
        return representative;
      }),
    );
    const passRateChanges = buildRunPassRateChanges(
      historyMetricsEnabled ? completeRuns : rows,
      comparisonRows,
    );
    const loadedRunCount = allSuiteGroups.reduce(
      (sum, suite) => sum + suite.launches.length,
      0,
    );
    return {
      historyRows,
      clientOptions,
      serverOptions,
      repositoryOptions,
      branchOptions,
      hasGitFilter,
      showGitContext,
      filtered,
      suiteGroups,
      launches,
      metricData,
      passRateChanges,
      loadedRunCount,
    };
  }, [
    rows,
    sourceAndSuiteRows,
    history.details,
    hosts,
    projectEnvironmentsEnabled,
    historyMetricsEnabled,
    sourceFilter,
    clientFilter,
    serverFilter,
    repositoryFilter,
    branchFilter,
    commitFilter,
  ]);
  const isSuiteExpanded = (suiteId: string) =>
    suiteExpansion.get(suiteId) ?? true;
  const renderRun = (row: ProjectRunRow, nested = false) => (
    <ProjectRunTableRow
      key={row._id}
      row={row}
      grouped={historyMetricsEnabled}
      nested={nested}
      historyMetricsEnabled={historyMetricsEnabled}
      showGitContext={showGitContext}
      historyRow={historyRows.get(row._id)}
      passRateChange={passRateChanges.get(row._id)}
      projectId={projectId}
      decisionSummaryEnabled={decisionSummaryEnabled}
      onSelectRun={onSelectRun}
    />
  );

  const isLoadingFirstPage = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const isFiltering =
    sourceFilter.size > 0 ||
    suiteFilter !== ALL_SUITES ||
    clientFilter !== ALL_EVAL_FILTER_VALUES ||
    serverFilter !== ALL_EVAL_FILTER_VALUES ||
    hasGitFilter;
  const hasClientSideFilter =
    (historyMetricsEnabled && sourceFilter.size > 0) ||
    suiteFilter !== ALL_SUITES ||
    clientFilter !== ALL_EVAL_FILTER_VALUES ||
    serverFilter !== ALL_EVAL_FILTER_VALUES ||
    hasGitFilter;

  const toggleSource = (value: string) => {
    if (value === "github" && sourceFilter.has("github")) {
      setRepositoryFilter(ALL_EVAL_FILTER_VALUES);
      setBranchFilter(ALL_EVAL_FILTER_VALUES);
      setCommitFilter("");
    }
    setSourceFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  if (isLoadingFirstPage && !historyMetricsEnabled) {
    return (
      <div
        className={cn(
          "flex items-center justify-center",
          embedded ? "min-h-40" : "h-full",
        )}
        role="status"
        aria-label="Loading runs"
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (rows.length === 0 && !isLoadingFirstPage && !isFiltering) {
    if (emptyState) {
      return emptyState;
    }
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
    <div
      className={cn(
        "flex min-w-0 flex-col",
        !embedded && "h-full min-h-0 overflow-y-auto px-6 pb-6 pt-5",
      )}
    >
      <section
        className={runHistorySurfaceClass}
        aria-label="Project run history"
      >
        <div className={runHistoryToolbarClass}>
          <div className="flex flex-wrap items-center gap-3">
            {embedded && !historyMetricsEnabled ? (
              <h2 className="text-xs font-semibold text-secondary-foreground">
                Run history
              </h2>
            ) : (
              <h2 className="text-xs font-semibold text-foreground">
                All Runs
              </h2>
            )}
          </div>
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
            {isFiltering && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => {
                  setSourceFilter(new Set());
                  setSuiteFilter(ALL_SUITES);
                  setClientFilter(ALL_EVAL_FILTER_VALUES);
                  setServerFilter(ALL_EVAL_FILTER_VALUES);
                  setRepositoryFilter(ALL_EVAL_FILTER_VALUES);
                  setBranchFilter(ALL_EVAL_FILTER_VALUES);
                  setCommitFilter("");
                }}
              >
                Clear filters
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    runHistoryFilterClass,
                    sourceFilter.size > 0 &&
                      "border-primary/40 ring-1 ring-primary/15",
                  )}
                  aria-label="Filter by platform"
                >
                  Platform
                  {sourceFilter.size > 0 ? ` · ${sourceFilter.size}` : ""}
                  <ChevronDown className="size-3" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {RUN_ORIGIN_FILTERS.map((filter) => (
                  <DropdownMenuCheckboxItem
                    key={filter.value}
                    checked={sourceFilter.has(filter.value)}
                    onCheckedChange={() => toggleSource(filter.value)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {filter.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Select value={suiteFilter} onValueChange={setSuiteFilter}>
              <SelectTrigger
                size="sm"
                aria-label="Filter by suite"
                title={suiteOptions.find(([id]) => id === suiteFilter)?.[1]}
                className={cn(
                  runHistoryFilterClass,
                  "min-w-0 max-w-44 [&>svg]:shrink-0",
                  suiteFilter !== ALL_SUITES &&
                    "border-primary/40 ring-1 ring-primary/15",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {suiteFilter === ALL_SUITES
                    ? "Suite"
                    : (suiteOptions.find(([id]) => id === suiteFilter)?.[1] ??
                      "Suite")}
                </span>
              </SelectTrigger>
              <SelectContent className="max-w-[min(24rem,calc(100vw-2rem))]">
                <SelectItem value={ALL_SUITES}>All suites</SelectItem>
                {suiteOptions.map(([id, name]) => (
                  <SelectItem
                    key={id}
                    value={id}
                    className="whitespace-normal break-words"
                    title={name}
                  >
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {historyMetricsEnabled && (
              <>
                <EvalListFilter
                  label="Client"
                  className={
                    clientFilter !== ALL_EVAL_FILTER_VALUES
                      ? "border-primary/40 ring-1 ring-primary/15"
                      : undefined
                  }
                  value={clientFilter}
                  options={clientOptions}
                  onChange={setClientFilter}
                  disabled={history.loading}
                />
                <EvalListFilter
                  label="Server"
                  className={
                    serverFilter !== ALL_EVAL_FILTER_VALUES
                      ? "border-primary/40 ring-1 ring-primary/15"
                      : undefined
                  }
                  value={serverFilter}
                  options={serverOptions}
                  onChange={setServerFilter}
                  disabled={history.loading}
                />
              </>
            )}
            {showGitContext && (
              <>
                <EvalListFilter
                  label="Repository"
                  className={
                    repositoryFilter !== ALL_EVAL_FILTER_VALUES
                      ? "border-primary/40 ring-1 ring-primary/15"
                      : undefined
                  }
                  value={repositoryFilter}
                  options={repositoryOptions}
                  onChange={setRepositoryFilter}
                />
                <EvalListFilter
                  label="Branch"
                  className={
                    branchFilter !== ALL_EVAL_FILTER_VALUES
                      ? "border-primary/40 ring-1 ring-primary/15"
                      : undefined
                  }
                  value={branchFilter}
                  options={branchOptions}
                  onChange={setBranchFilter}
                />
                <Input
                  aria-label="Filter by commit"
                  placeholder="Commit SHA"
                  value={commitFilter}
                  onChange={(event) => setCommitFilter(event.target.value)}
                  className={cn(
                    "h-7 w-32 rounded-full text-[11px]",
                    commitFilter.trim() &&
                      "border-primary/40 ring-1 ring-primary/15",
                  )}
                />
              </>
            )}
          </div>
        </div>
        {!historyMetricsEnabled && (
          <RunHistorySummary aria-label="Filtered run summary">
            <RunHistoryStat value={filtered.length} label="runs shown" />
            <RunHistoryStat
              value={new Set(filtered.map((row) => row.suiteId)).size}
              label="suites"
            />
            <RunHistoryStat
              value={
                new Set(
                  filtered.map((row) => row.source ?? row.suiteSource ?? "ui"),
                ).size
              }
              label="platforms"
            />
            <RunHistoryStat
              value={
                filtered.filter((row) =>
                  ["pending", "running", "grading"].includes(row.status),
                ).length
              }
              label="in progress"
            />
          </RunHistorySummary>
        )}
        {historyMetricsEnabled && (rows.length > 0 || isLoadingFirstPage) && (
          <div
            className="@container/history-metrics border-b border-border/50"
            aria-label="Filtered run metrics"
          >
            {history.errorCount > 0 && (
              <p className="px-5 py-2 text-xs text-muted-foreground">
                Metrics unavailable for {history.errorCount} runs.
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={history.retry}
                >
                  Retry metrics
                </button>
              </p>
            )}
            {!metricData && (history.loading || isLoadingFirstPage) && (
              <div
                className="grid h-32 grid-cols-5 gap-6 px-5 py-5"
                aria-hidden="true"
              >
                {[0, 1, 2, 3, 4].map((index) => (
                  <div key={index} className="space-y-4">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-6 w-20" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                ))}
              </div>
            )}
            {metricData && (
              <MetricStrip
                bars={metricBars}
                showCost={!metricBars || metricData.latest.costUsd != null}
                data={metricData}
                surface="embedded"
                context="history"
                testId="project-run-history-metrics"
              />
            )}
          </div>
        )}
        {/*
          Only for the filters that run over the loaded page. The platform
          chips are a query argument, so on their own an empty result really
          does mean the project has no such runs, and this caveat would
          suggest the opposite.
        */}
        {hasClientSideFilter && canLoadMore && (
          <p className="px-[18px] pb-3 text-[11px] text-muted-foreground">
            Filtering the {historyMetricsEnabled ? loadedRunCount : rows.length}{" "}
            most recent runs loaded so far. Load more below to widen the search.
          </p>
        )}
        <div className="overflow-x-auto">
          <RunHistoryTable aria-label="Project runs">
            <TableHeader>
              <TableRow>
                {historyMetricsEnabled ? (
                  <>
                    <TableHead className="min-w-[120px]">Date</TableHead>
                    <TableHead className="min-w-[140px]">Run</TableHead>
                  </>
                ) : (
                  <TableHead className="min-w-[180px]">Suite / Run</TableHead>
                )}
                <TableHead className="min-w-[120px]">
                  {historyMetricsEnabled ? "Client : model" : "Platform"}
                </TableHead>
                {showGitContext && (
                  <>
                    <TableHead className="min-w-[100px]">Commit</TableHead>
                    <TableHead className="min-w-[80px]">PR</TableHead>
                    <TableHead className="min-w-[160px]">Branch</TableHead>
                  </>
                )}
                <TableHead>
                  {historyMetricsEnabled ? "Status" : "Verdict"}
                </TableHead>
                <TableHead
                  className={historyMetricsEnabled ? "text-right" : undefined}
                >
                  {historyMetricsEnabled ? "Iteration pass" : "Results"}
                </TableHead>
                {!historyMetricsEnabled && <TableHead>Date</TableHead>}
                <TableHead className="text-right">
                  {historyMetricsEnabled ? "Latency p50" : "Duration"}
                </TableHead>
                <TableHead
                  className={historyMetricsEnabled ? "text-right" : undefined}
                >
                  {historyMetricsEnabled ? "Total tokens" : "Run by"}
                </TableHead>
                {historyMetricsEnabled && (
                  <>
                    <TableHead className="text-right">Tool calls</TableHead>
                    <TableHead>Platform</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoadingFirstPage ? (
                <TableRow>
                  <TableCell
                    colSpan={
                      (historyMetricsEnabled ? 9 : 7) + (showGitContext ? 3 : 0)
                    }
                    className="h-32 text-center text-muted-foreground"
                  >
                    <span role="status">Loading runs…</span>
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={
                      (historyMetricsEnabled ? 9 : 7) + (showGitContext ? 3 : 0)
                    }
                    className="h-24 text-center text-sm text-muted-foreground"
                  >
                    {history.loading &&
                    (clientFilter !== ALL_EVAL_FILTER_VALUES ||
                      serverFilter !== ALL_EVAL_FILTER_VALUES)
                      ? "Loading matching runs…"
                      : "No runs match these filters."}
                  </TableCell>
                </TableRow>
              ) : historyMetricsEnabled ? (
                suiteGroups.map((group) => (
                  <ProjectRunSuiteGroup
                    key={group.suiteId}
                    group={group}
                    expanded={isSuiteExpanded(group.suiteId)}
                    onToggle={() =>
                      setSuiteExpansion((previous) =>
                        new Map(previous).set(
                          group.suiteId,
                          !isSuiteExpanded(group.suiteId),
                        ),
                      )
                    }
                    details={history.details}
                    historyRows={historyRows}
                    showGitContext={showGitContext}
                    loading={history.loading}
                    renderRun={renderRun}
                    onSelectRun={onSelectRun}
                  />
                ))
              ) : (
                filtered.map((row) => renderRun(row))
              )}
            </TableBody>
          </RunHistoryTable>
        </div>
        <div className={runHistoryFooterClass}>
          <span>
            {historyMetricsEnabled &&
            (isLoadingFirstPage ||
              rows.some((row) => !history.details.has(row._id)))
              ? history.loading || isLoadingFirstPage
                ? "Loading run history…"
                : "Run history incomplete"
              : `${
                  historyMetricsEnabled ? launches.length : filtered.length
                } of ${
                  historyMetricsEnabled ? loadedRunCount : rows.length
                } loaded runs`}
            {status !== "Exhausted" ? " · more available" : ""}
          </span>
          {canLoadMore ? (
            <button
              type="button"
              className="font-medium text-foreground hover:underline"
              onClick={() => loadMore(PROJECT_RUNS_PAGE_SIZE)}
            >
              Load more →
            </button>
          ) : status === "LoadingMore" ? (
            <span role="status" className="flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              Loading more…
            </span>
          ) : null}
        </div>
      </section>
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
/**
 * WHO started this run — the person, and the credential they used.
 *
 * The name alone was ambiguous in the one case that matters: a run made with an
 * API key is attributed to the key's owner, so an automated launch and that
 * person clicking Run read identically. `attribution.apiKeyId` is minted by the
 * backend from the credential the request authenticated with — a fact, not a
 * claim — so the second line can say which key without guessing.
 *
 * An MCP run names the calling agent instead, which is the more useful answer
 * there: "claude-code" tells you what to look at; "via API key ····3f9a" tells
 * you which key to rotate.
 */
function RunByCell({ row }: { row: ProjectRunRow }) {
  const name = row.createdByName ?? "—";
  const agent = runAgentName(row);
  const keyTail = agent ? null : apiKeyTail(row.attribution?.apiKeyId);
  return (
    <span className="flex flex-col leading-tight">
      <span className="truncate">{name}</span>
      {agent ? (
        <span className="truncate text-[10px] opacity-70" title={agent}>
          via {agent}
        </span>
      ) : keyTail ? (
        <span className="text-[10px] opacity-70">via API key {keyTail}</span>
      ) : null}
    </span>
  );
}

function ProjectRunTableRow({
  row,
  grouped = false,
  nested = false,
  historyMetricsEnabled,
  showGitContext,
  historyRow,
  passRateChange,
  projectId,
  decisionSummaryEnabled,
  onSelectRun,
}: {
  row: ProjectRunRow;
  grouped?: boolean;
  nested?: boolean;
  historyMetricsEnabled: boolean;
  showGitContext: boolean;
  historyRow?: SuiteRunHistoryRow;
  passRateChange?: RunPassRateChange;
  projectId: string;
  decisionSummaryEnabled: boolean;
  onSelectRun: (args: { suiteId: string; runId: string }) => void;
}) {
  const [visibilityRef, hasBeenVisible, onScreen] =
    useHasBeenVisible<HTMLTableRowElement>();
  const terminal = isTerminalEvalRunStatus(row.status);
  const {
    status: summaryStatus,
    summary,
    error,
  } = useEvalRunDecisionBadge({
    projectId,
    runId: row._id,
    enabled:
      decisionSummaryEnabled &&
      !historyMetricsEnabled &&
      terminal &&
      hasBeenVisible,
    // Sticky to FETCH, live to REVALIDATE: a row keeps its answer once read,
    // but only the rows on screen keep asking whether it changed.
    revalidate: onScreen,
    revision: evalRunDecisionRevision(row),
  });
  // SETTLED without a summary. The lifecycle label is this row's answer only
  // until the run's own answer is known to be unreadable — after that,
  // presenting it is presenting a derivation as if it were the verdict.
  const summaryUnavailable = summaryStatus === "error";

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
  const git = isGithubRun(row) ? readRunGitMetadata(row.ciMetadata) : null;

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
      {historyMetricsEnabled ? (
        <TableCell className="whitespace-nowrap text-muted-foreground">
          <span title={formatTime(row.createdAt)}>
            {formatRunHistoryDate(row.createdAt)}
          </span>
        </TableCell>
      ) : null}
      <TableCell className="max-w-[240px] text-xs">
        <div className={grouped ? (nested ? "pl-12" : "pl-5") : undefined}>
          <span className="block truncate font-medium">
            {grouped
              ? `#${row.runNumber}`
              : (row.suiteName ?? (
                  <span
                    className="text-muted-foreground"
                    title="This run's suite no longer exists, so its detail view can't be opened."
                  >
                    Deleted suite
                  </span>
                ))}
          </span>
          <span className="text-[10px] text-muted-foreground" title={row._id}>
            {grouped
              ? formatRunId(row._id)
              : `#${row.runNumber} · ${formatRunId(row._id)}`}
          </span>
        </div>
      </TableCell>
      {historyMetricsEnabled ? (
        <TableCell className="text-xs">
          <RunClientsCell rows={historyRow ? [historyRow] : []} />
        </TableCell>
      ) : (
        <TableCell>
          <div className="flex flex-col items-start gap-1">
            <RunPlatformBadge run={row} />
            {row.ciMetadata && !showGitContext && (
              <CiMetadataDisplay
                ciMetadata={row.ciMetadata}
                compact
                compactMode="chip"
                interactive={false}
              />
            )}
          </div>
        </TableCell>
      )}
      {showGitContext && (
        <>
          <TableCell>
            <RunCommitCell git={git} />
          </TableCell>
          <TableCell>
            <RunPullRequestCell git={git} />
          </TableCell>
          <TableCell>
            <RunBranchCell git={git} />
          </TableCell>
        </>
      )}
      <TableCell>
        {historyMetricsEnabled ? (
          <span className="text-[10px] text-muted-foreground">
            {terminal ? "Finished" : "In progress"}
          </span>
        ) : summary ? (
          // The run's own verdict replaces the status-derived label outright,
          // `inconclusive` and "no verdict" included — those are answers this
          // column could not previously express at all.
          <RunDecisionVerdictBadge summary={summary} />
        ) : summaryUnavailable ? (
          <RunDecisionVerdictUnavailable error={error} />
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
      {historyMetricsEnabled ? (
        <TableCell className="text-right text-xs tabular-nums">
          {historyRow?.passRate != null
            ? `${Math.round(historyRow.passRate)}%`
            : "—"}
          {passRateChange && (
            <span
              className={cn(
                "ml-2 whitespace-nowrap text-[10px]",
                passRateChange.points > 0
                  ? "text-success"
                  : passRateChange.points < 0
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
              title={`Compared with run #${passRateChange.previousRunNumber} in this suite (loaded history)`}
              aria-label={`${
                passRateChange.points > 0
                  ? "Up"
                  : passRateChange.points < 0
                    ? "Down"
                    : "Unchanged"
              } ${Math.abs(
                passRateChange.points,
              )} percentage points versus run #${
                passRateChange.previousRunNumber
              } in this suite`}
            >
              {passRateChange.points > 0
                ? "↑"
                : passRateChange.points < 0
                  ? "↓"
                  : "→"}
              {Math.abs(passRateChange.points)} pp
            </span>
          )}
        </TableCell>
      ) : (
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
          ) : summary || summaryUnavailable ? (
            // Either the summary ARRIVED and reported no counts — a legacy run
            // that recorded none, or a run with no verdict, for which the
            // contract forbids them outright — or the read settled unreadable.
            // Absence stays absence either way: the stored aggregate is a
            // different reading of this run, and printing it beside a canonical
            // verdict (or beside "we could not read one") puts two answers in
            // one row.
            <span className="flex flex-col leading-tight">
              <span>—</span>
              <span className="text-[10px] opacity-70">no counts reported</span>
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
      )}
      {historyMetricsEnabled ? (
        <>
          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
            {formatRunHistoryMetric(historyRow?.latencyMs ?? null, "duration")}
          </TableCell>
          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
            {formatRunHistoryMetric(historyRow?.tokens ?? null, "number")}
          </TableCell>
          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
            {formatRunHistoryMetric(historyRow?.toolCalls ?? null, "number")}
          </TableCell>
          <TableCell>
            <div className="flex flex-col items-start gap-1">
              <RunPlatformBadge run={row} />
              {row.ciMetadata && !showGitContext && (
                <CiMetadataDisplay
                  ciMetadata={row.ciMetadata}
                  compact
                  compactMode="chip"
                  interactive={false}
                />
              )}
            </div>
          </TableCell>
        </>
      ) : (
        <>
          <TableCell className="text-xs text-muted-foreground">
            <time
              dateTime={new Date(row.createdAt).toISOString()}
              title={formatTime(row.createdAt)}
            >
              <span className="block">
                {new Date(row.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <span className="text-[10px]">
                {new Date(row.createdAt).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </time>
          </TableCell>
          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
            {row.durationMs != null ? formatDuration(row.durationMs) : "—"}
          </TableCell>
          <TableCell className="max-w-[140px] text-xs text-muted-foreground">
            <RunByCell row={row} />
          </TableCell>
        </>
      )}
    </TableRow>
  );
}
