import { useMemo, useState } from "react";
import { FileUp, Loader2, MessageSquareText, Play, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "../evals/eval-surface-chrome";
import { getEffectiveSuiteServers } from "../evals/helpers";
import {
  SUITE_RUN_HISTORY_PAGE_SIZE,
  buildSuiteRunHistoryAggregates,
  buildSuiteRunHistoryRows,
  buildSuiteTestCaseRows,
  filterSuiteRunHistoryRows,
  formatRunHistoryMetric,
  runHistoryFilterOptions,
  suiteRunBlockedReason,
  type RunHistoryVerdict,
  type SuiteRunHistoryFilters,
  type SuiteRunHistoryRow,
} from "./suite-detail-model";
import { StageAnalyticsPanel } from "./stage-analytics-panel";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../evals/types";
import {
  RunDecisionVerdictBadge,
  RunDecisionVerdictUnavailable,
} from "../evals/run-decision-summary-card";
import { useEvalRunDecisionBadge, useHasBeenVisible } from "@/hooks/use-eval-run-decision-summary";
import { isTerminalEvalRunStatus } from "@/lib/evals/eval-decision-summary-store";

export const SUITE_EMPTY_CASES_TITLE = "No cases yet";
export const SUITE_EMPTY_CASES_DESCRIPTION =
  "Describe a behavior, generate from your servers' live discovery, or import an existing test file.";
export const SUITE_IMPORT_UNAVAILABLE_MESSAGE =
  "Import from Markdown, Word, or a test file isn't available yet.";

const EMPTY_CASE_ACTIONS = [
  {
    id: "describe",
    title: "Describe",
    description: "Tell us a behavior — chat drafts the case",
    Icon: MessageSquareText,
  },
  {
    id: "generate",
    title: "Generate",
    description: "From live discovery of your servers",
    Icon: Sparkles,
  },
  {
    id: "import",
    title: "Import",
    description: "MD / docx / test file → cases",
    Icon: FileUp,
  },
] as const;

const VERDICT_TEXT_TONE: Record<RunHistoryVerdict, string> = {
  ship: "text-success",
  passed: "text-success",
  hold: "text-amber-700 dark:text-amber-400",
  failed: "text-destructive",
  running: "text-muted-foreground",
  pending: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};

const runHistoryHeadClass =
  "h-9 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

export function SuiteDetailOverview({
  suite,
  cases,
  runs,
  runsLoading,
  allIterations,
  hostNamesById,
  onRerun,
  onEditSuite,
  onEditCases,
  onGenerateTestCases,
  canGenerateTestCases = false,
  generateTestCasesDisabledReason,
  isGeneratingTestCases = false,
  onImportCases,
  onRunClick,
  onTestCaseClick,
  rerunningSuiteId,
  replayingRunId = null,
  runningTestCaseId = null,
  evalRunsDisabledReason = null,
  readOnlyConfig = false,
  projectId = null,
  decisionSummaryEnabled = false,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  allIterations: EvalIteration[];
  hostNamesById: Map<string, string | null>;
  onRerun: (suite: EvalSuite) => void;
  onEditSuite: () => void;
  onEditCases?: () => void;
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  generateTestCasesDisabledReason?: string;
  isGeneratingTestCases?: boolean;
  onImportCases?: () => void;
  onRunClick: (runId: string) => void;
  onTestCaseClick: (testCaseId: string) => void;
  rerunningSuiteId: string | null;
  replayingRunId?: string | null;
  runningTestCaseId?: string | null;
  evalRunsDisabledReason?: string | null;
  readOnlyConfig?: boolean;
  /** Threaded from `EvaluateTab`; never resolved in the browser. */
  projectId?: string | null;
  /**
   * Read D9's canonical verdict for terminal rows. OFF by default: with it
   * false this table issues no decision-summary requests at all.
   */
  decisionSummaryEnabled?: boolean;
}) {
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const [filters, setFilters] = useState<SuiteRunHistoryFilters>({
    verdict: "all",
    client: "all",
    model: "all",
  });
  const [showAllRuns, setShowAllRuns] = useState(false);

  const historyRows = useMemo(
    () =>
      buildSuiteRunHistoryRows(
        runs,
        allIterations,
        suite,
        hostNamesById,
        projectEnvironmentsEnabled,
      ),
    [runs, allIterations, suite, hostNamesById, projectEnvironmentsEnabled],
  );
  const filterOptions = useMemo(
    () => runHistoryFilterOptions(historyRows),
    [historyRows],
  );
  // A selected value can vanish from the option set — runs stream in live, and
  // a rerun on a different model retires the old one. A Select whose value is
  // absent from its items renders blank while still filtering every row away,
  // so fall back to "all" rather than stranding the table on a choice the user
  // can no longer see or clear.
  const effectiveFilters = useMemo<SuiteRunHistoryFilters>(
    () => ({
      verdict:
        filters.verdict === "all" ||
        filterOptions.verdicts.includes(filters.verdict)
          ? filters.verdict
          : "all",
      client:
        filters.client === "all" ||
        filterOptions.clients.includes(filters.client)
          ? filters.client
          : "all",
      model:
        filters.model === "all" || filterOptions.models.includes(filters.model)
          ? filters.model
          : "all",
    }),
    [filters, filterOptions],
  );
  const filteredRows = useMemo(
    () => filterSuiteRunHistoryRows(historyRows, effectiveFilters),
    [historyRows, effectiveFilters],
  );
  const visibleRows = showAllRuns
    ? filteredRows
    : filteredRows.slice(0, SUITE_RUN_HISTORY_PAGE_SIZE);
  const hiddenRunCount = filteredRows.length - visibleRows.length;

  const aggregates = useMemo(
    () => buildSuiteRunHistoryAggregates(runs, allIterations),
    [runs, allIterations],
  );
  const testCaseRows = useMemo(() => buildSuiteTestCaseRows(cases), [cases]);

  const isEnvironmentSuite = (suite.environmentIds?.length ?? 0) > 0;
  const hasServersConfigured = getEffectiveSuiteServers(suite).length > 0;
  const isRerunning = rerunningSuiteId === suite._id;
  const runBlockedReason = suiteRunBlockedReason({
    caseCount: cases.length,
    hasServersConfigured,
    isEnvironmentSuite,
    isRerunning,
    isReplaying: replayingRunId != null,
    runningTestCase: runningTestCaseId != null,
    evalRunsDisabledReason,
  });
  const runDisabled = Boolean(runBlockedReason);
  const hasCases = cases.length > 0;
  // Runs load after the detail spinner has already cleared (`isSuiteRunsLoading`
  // is its own query), so keying purely on `runs.length` hides the whole section
  // from a suite that HAS runs and then pops it in. Hold the frame instead.
  const showRunHistory = runs.length > 0 || runsLoading;
  const showEmptyCasesHero = !hasCases;

  const runButton = (
    <Button
      type="button"
      size="sm"
      className="h-8 gap-1.5"
      disabled={runDisabled}
      aria-label="Run this suite"
      aria-busy={isRerunning}
      onClick={() => onRerun(suite)}
    >
      {isRerunning ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      ) : (
        <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      Run
    </Button>
  );

  return (
    <div
      className={cn(
        "flex min-h-full flex-col gap-4 pb-6",
        showEmptyCasesHero && !showRunHistory && "flex-1",
      )}
      data-testid="suite-detail-overview"
    >
      <div
        className="flex min-w-0 flex-wrap items-start justify-between gap-3"
        data-testid="suite-detail-identity"
      >
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">
            {suite.name}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!readOnlyConfig ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onEditSuite}
            >
              Edit
            </Button>
          ) : null}
          {runDisabled && runBlockedReason ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{runButton}</span>
              </TooltipTrigger>
              <TooltipContent
                variant="muted"
                side="bottom"
                className="max-w-[16rem]"
              >
                {runBlockedReason}
              </TooltipContent>
            </Tooltip>
          ) : (
            runButton
          )}
        </div>
      </div>

      {showRunHistory ? (
      <section
        className={cn(
          evalSurfaceCardClass,
          "overflow-hidden bg-muted/35 dark:bg-muted/20",
        )}
        data-testid="suite-detail-run-history"
      >
        <div
          className={cn(
            evalSurfaceHeaderClass,
            "flex flex-wrap items-center justify-between gap-3 border-border/30 bg-transparent px-5 py-3.5",
          )}
        >
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
            Run History
          </h3>
          {historyRows.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {filterOptions.verdicts.length > 0 ? (
                <FilterSelect
                  label="Verdict"
                  value={effectiveFilters.verdict}
                  onChange={(verdict) =>
                    setFilters((current) => ({
                      ...current,
                      verdict: verdict as SuiteRunHistoryFilters["verdict"],
                    }))
                  }
                  options={[
                    { value: "all", label: "All" },
                    ...filterOptions.verdicts.map((verdict) => ({
                      value: verdict,
                      label: verdictLabel(verdict),
                    })),
                  ]}
                />
              ) : null}
              {filterOptions.clients.length > 0 ? (
                <FilterSelect
                  label="Client"
                  value={effectiveFilters.client}
                  onChange={(client) =>
                    setFilters((current) => ({ ...current, client }))
                  }
                  options={[
                    { value: "all", label: "All" },
                    ...filterOptions.clients.map((client) => ({
                      value: client,
                      label: client,
                    })),
                  ]}
                />
              ) : null}
              {filterOptions.models.length > 0 ? (
                <FilterSelect
                  label="Model"
                  value={effectiveFilters.model}
                  onChange={(model) =>
                    setFilters((current) => ({ ...current, model }))
                  }
                  options={[
                    { value: "all", label: "All" },
                    ...filterOptions.models.map((model) => ({
                      value: model,
                      label: model,
                    })),
                  ]}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        {runs.length > 0 ? (
          <div
            className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-border/30 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6"
            data-testid="suite-detail-run-aggregates"
          >
            <AggregateStat label="runs" value={String(aggregates.runCount)} />
            <AggregateStat
              label="tokens"
              value={formatRunHistoryMetric(aggregates.totalTokens, "number")}
            />
            <AggregateStat
              label="P50 latency"
              value={formatRunHistoryMetric(aggregates.latencyP50, "duration")}
            />
            <AggregateStat
              label="P95 latency"
              value={formatRunHistoryMetric(aggregates.latencyP95, "duration")}
            />
            <AggregateStat
              label="tokens per run"
              value={formatRunHistoryMetric(aggregates.tokensPerRun, "number")}
            />
            <AggregateStat
              label="tool calls per run"
              value={formatRunHistoryMetric(aggregates.toolCallsPerRun, "number")}
            />
          </div>
        ) : null}

        {filteredRows.length === 0 ? (
          <div className="bg-card px-5 py-10 text-center text-sm text-muted-foreground">
            {runsLoading ? "Loading runs…" : "No runs match these filters."}
          </div>
        ) : (
          <div className="overflow-x-auto bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/30">
                  <TableHead className={runHistoryHeadClass}>Date</TableHead>
                  <TableHead className={runHistoryHeadClass}>Verdict</TableHead>
                  <TableHead className={cn(runHistoryHeadClass, "text-right")}>
                    Rate
                  </TableHead>
                  <TableHead className={runHistoryHeadClass}>
                    Top failure signature
                  </TableHead>
                  <TableHead className={runHistoryHeadClass}>Platform</TableHead>
                  <TableHead className={cn(runHistoryHeadClass, "text-right")}>
                    Latency
                  </TableHead>
                  <TableHead className={cn(runHistoryHeadClass, "text-right")}>
                    Tokens/run
                  </TableHead>
                  <TableHead className={cn(runHistoryHeadClass, "text-right")}>
                    Tool calls/run
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row, index) => (
                  <TableRow
                    key={row.runId}
                    data-testid={`suite-run-row-${row.runId}`}
                    className={cn(
                      "cursor-pointer border-border/25",
                      evalSurfaceRowHoverClass,
                    )}
                    onClick={() => onRunClick(row.runId)}
                  >
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {row.dateLabel}
                    </TableCell>
                    <TableCell>
                      <SuiteRunVerdictCell
                        row={row}
                        projectId={projectId}
                        enabled={decisionSummaryEnabled}
                        // The first page is on screen the moment the table
                        // paints, so it reads eagerly. Everything "Show all"
                        // reveals waits to be scrolled to — otherwise one
                        // click would ask for the entire history at once.
                        lazy={index >= SUITE_RUN_HISTORY_PAGE_SIZE}
                      />
                    </TableCell>
                    {/*
                      DELIBERATELY still the locally derived rate, and the one
                      place this surface diverges from the project Runs table.

                      There, the Metric column is the run's own counts, so a
                      canonical summary replaces the stored aggregate outright.
                      Here the column is per-TRIAL accuracy shown beside
                      latency, tokens and tool calls — a row of local operating
                      metrics, not a restatement of the verdict. Swapping in
                      case-variant counts would put a different population in
                      the middle of that row.

                      What it must never do is contradict the verdict, and it
                      cannot: the verdict cell reads the canonical summary and
                      this cell has no say in it. Lane D10a keeps this local
                      context; retiring it is a later change with its own
                      column design.
                    */}
                    <TableCell className="text-right text-xs tabular-nums text-foreground">
                      {row.passRate != null ? `${row.passRate}%` : "—"}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                      {row.topFailureSignature ?? "—"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap text-xs",
                        row.source === "github_check"
                          ? "font-medium text-sky-600 dark:text-sky-400"
                          : "text-foreground",
                      )}
                    >
                      {row.platform}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {formatRunHistoryMetric(row.latencyMs, "duration")}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {formatRunHistoryMetric(row.tokens, "number")}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {formatRunHistoryMetric(row.toolCalls, "number")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="border-t border-border/30 bg-card px-5 py-2.5 text-xs text-muted-foreground">
          {hiddenRunCount > 0 ? (
            <>
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setShowAllRuns(true)}
              >
                view all {filteredRows.length.toLocaleString()} runs →
              </button>
              <span aria-hidden> · </span>
            </>
          ) : null}
          <span>
            quick runs appear tagged &apos;quick · nx&apos;, grayed, excluded
            from stability
          </span>
        </div>
      </section>
      ) : null}

      {/* Where the chain stopped, per run — the measured half of a run, beside
          its history. Evaluate-only by construction: this file is the Evaluate
          (New) suite page, so /evals cannot pick it up.

          Gated on `projectId` because it is genuinely nullable here and the
          read is project-scoped: without one there is no request to make, and
          rendering the panel anyway would leave it spinning on a fetch that
          never starts. Same gate the traces export uses above. */}
      {projectId ? (
        <StageAnalyticsPanel
          projectId={projectId}
          suiteId={suite._id}
          runCount={runs.length}
          runsLoading={runsLoading}
          // The run rows the findings read needs for the SELECTED document's
          // status and revision — the analytics document carries neither.
          runs={runs}
          // "Open run", not a trace: deep trace focus exists only on the run
          // page, and this is the affordance that surface actually has.
          onRunClick={onRunClick}
          // The same flag the verdict cell above already rides. Nothing new to
          // turn on, and with it off no decision-summary request is issued.
          decisionSummaryEnabled={decisionSummaryEnabled}
        />
      ) : null}

      {showEmptyCasesHero ? (
        <SuiteEmptyCasesHero
          readOnly={readOnlyConfig}
          onDescribe={onEditCases}
          onGenerate={onGenerateTestCases}
          canGenerate={canGenerateTestCases}
          generateDisabledReason={generateTestCasesDisabledReason}
          isGenerating={isGeneratingTestCases}
          onImport={onImportCases}
          fillRemaining={!showRunHistory}
        />
      ) : (
      <section
        className={evalSurfaceCardClass}
        data-testid="suite-detail-test-cases"
      >
        <div
          className={cn(
            evalSurfaceHeaderClass,
            "flex items-center justify-between gap-3 px-4 py-3",
          )}
        >
          <h3 className="text-sm font-semibold text-foreground">Test Cases</h3>
          {!readOnlyConfig ? (
            <div className="flex shrink-0 items-center gap-2">
              {/* Generate lives here as well as in the empty hero. Reaching it
                  only through the hero would mean a suite loses the affordance
                  the moment it has its first case, which is exactly when
                  "generate more from live discovery" is most useful. */}
              {onGenerateTestCases ? (
                <GenerateCasesButton
                  onGenerate={onGenerateTestCases}
                  canGenerate={canGenerateTestCases}
                  disabledReason={generateTestCasesDisabledReason}
                  isGenerating={isGeneratingTestCases}
                />
              ) : null}
              {onEditCases ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={onEditCases}
                >
                  Add case
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <ul className="divide-y divide-border/40">
          {testCaseRows.map((row) => (
            <li key={row.caseId}>
              <button
                type="button"
                data-testid={`suite-test-case-row-${row.caseId}`}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left",
                  evalSurfaceRowHoverClass,
                )}
                onClick={() => onTestCaseClick(row.caseId)}
              >
                <span className="text-sm font-medium text-foreground">
                  {row.title}
                </span>
                {row.summary ? (
                  <span className="text-xs text-muted-foreground">
                    {row.summary}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
      )}
    </div>
  );
}

function GenerateCasesButton({
  onGenerate,
  canGenerate,
  disabledReason,
  isGenerating,
}: {
  onGenerate: () => void;
  canGenerate: boolean;
  disabledReason?: string;
  isGenerating: boolean;
}) {
  const blocked = isGenerating
    ? "Generating test cases…"
    : !canGenerate
      ? (disabledReason ?? "Configure suite servers before generating cases.")
      : null;

  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5"
      data-testid="suite-detail-generate-cases"
      disabled={Boolean(blocked)}
      aria-busy={isGenerating}
      onClick={onGenerate}
    >
      {isGenerating ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      ) : (
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
      )}
      Generate
    </Button>
  );

  if (!blocked) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent variant="muted" side="bottom" className="max-w-[16rem]">
        {blocked}
      </TooltipContent>
    </Tooltip>
  );
}

function SuiteEmptyCasesHero({
  readOnly,
  onDescribe,
  onGenerate,
  canGenerate,
  generateDisabledReason,
  isGenerating,
  onImport,
  fillRemaining,
}: {
  readOnly: boolean;
  onDescribe?: () => void;
  onGenerate?: () => void;
  canGenerate: boolean;
  generateDisabledReason?: string;
  isGenerating: boolean;
  onImport?: () => void;
  fillRemaining: boolean;
}) {
  const handleAction = (id: (typeof EMPTY_CASE_ACTIONS)[number]["id"]) => {
    if (id === "describe") {
      onDescribe?.();
      return;
    }
    if (id === "generate") {
      onGenerate?.();
      return;
    }
    if (onImport) {
      onImport();
      return;
    }
    toast.info(SUITE_IMPORT_UNAVAILABLE_MESSAGE);
  };

  return (
    <div
      className={cn(
        "flex min-h-[20rem] flex-col items-center justify-center rounded-xl border border-dashed border-border/70 px-6 py-12",
        fillRemaining && "min-h-0 flex-1",
      )}
      data-testid="suite-detail-empty-cases"
    >
      <h3 className="text-sm font-semibold text-foreground">
        {SUITE_EMPTY_CASES_TITLE}
      </h3>
      <p className="mt-1 max-w-md text-center text-sm text-muted-foreground">
        {SUITE_EMPTY_CASES_DESCRIPTION}
      </p>
      {!readOnly ? (
        <div className="mt-6 flex w-full max-w-2xl flex-col gap-3 sm:flex-row">
          {EMPTY_CASE_ACTIONS.map((action) => {
            const disabled =
              action.id === "describe"
                ? !onDescribe
                : action.id === "generate"
                  ? !onGenerate || !canGenerate || isGenerating
                  : false;
            const generateTooltip =
              action.id === "generate"
                ? isGenerating
                  ? "Generating test cases…"
                  : !canGenerate
                    ? (generateDisabledReason ??
                      "Configure suite servers before generating cases.")
                    : null
                : null;
            const button = (
              <button
                type="button"
                data-testid={`suite-empty-action-${action.id}`}
                disabled={disabled}
                aria-busy={action.id === "generate" && isGenerating}
                onClick={() => handleAction(action.id)}
                className={cn(
                  "flex min-h-11 min-w-0 flex-1 flex-col items-start gap-1 rounded-lg border border-border bg-background px-4 py-3 text-left shadow-xs transition-colors",
                  "hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                  {action.id === "generate" && isGenerating ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                  ) : (
                    <action.Icon className="size-4 shrink-0" aria-hidden />
                  )}
                  {action.title}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </button>
            );

            if (!generateTooltip) {
              return (
                <div key={action.id} className="flex min-w-0 flex-1">
                  {button}
                </div>
              );
            }

            return (
              <Tooltip key={action.id}>
                <TooltipTrigger asChild>
                  <span className="flex min-w-0 flex-1">{button}</span>
                </TooltipTrigger>
                <TooltipContent
                  variant="muted"
                  side="bottom"
                  sideOffset={6}
                  className="max-w-[16rem]"
                >
                  {generateTooltip}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The verdict for one run-history row.
 *
 * CANONICAL WINS. `row.verdict` is derived in the browser from iteration rows
 * — a second reading of a run that already decided for itself — and the moment
 * a validated summary is in hand it replaces that derivation outright,
 * `inconclusive` and "no verdict" included. The local label survives only as
 * the pre-canonical placeholder, and on a non-terminal row (which has no
 * decision to read) as the lifecycle it always was.
 */
function SuiteRunVerdictCell({
  row,
  projectId,
  enabled,
  lazy,
}: {
  row: SuiteRunHistoryRow;
  projectId: string | null;
  enabled: boolean;
  lazy: boolean;
}) {
  const [visibilityRef, hasBeenVisible, onScreen] =
    useHasBeenVisible<HTMLSpanElement>();
  const terminal = isTerminalEvalRunStatus(row.status);
  const { status, summary, error } = useEvalRunDecisionBadge({
    projectId,
    runId: row.runId,
    enabled: enabled && terminal && (!lazy || hasBeenVisible),
    // Eagerly-read first-page rows are on screen by definition; lazy ones
    // revalidate only while they actually are. See the runs table for why.
    revalidate: !lazy || onScreen,
    revision: row.revision,
  });

  return (
    <span ref={lazy ? visibilityRef : undefined}>
      {summary ? (
        <RunDecisionVerdictBadge summary={summary} />
      ) : status === "error" ? (
        // The read SETTLED and there is no verdict to show. `Ship`/`Hold` is
        // this table's own pass-rate derivation, and leaving it up here — with
        // nothing saying the run's own answer could not be read — is exactly
        // the silent disagreement this surface exists to remove.
        <RunDecisionVerdictUnavailable error={error} />
      ) : (
        <span
          className={cn(
            "text-xs font-medium uppercase tracking-wide",
            VERDICT_TEXT_TONE[row.verdict],
          )}
        >
          {row.verdictLabel}
        </span>
      )}
    </span>
  );
}

function verdictLabel(verdict: RunHistoryVerdict): string {
  switch (verdict) {
    case "ship":
      return "Ship";
    case "hold":
      return "Hold";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
    case "cancelled":
      return "Cancelled";
  }
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const isActive = value !== "all";
  // Name the selection, not just the dimension. A border tint alone leaves the
  // reader guessing which of three pills is narrowing the table, and by what.
  const selectedLabel = options.find((option) => option.value === value)?.label;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={`Filter by ${label.toLowerCase()}`}
        className={cn(
          "h-7 gap-1 rounded-full border-border/60 bg-background px-3 text-xs font-medium shadow-none",
          "hover:bg-background dark:bg-background dark:hover:bg-background",
          isActive && "border-foreground/25 text-foreground",
        )}
      >
        <span className="truncate">
          {isActive && selectedLabel ? `${label} · ${selectedLabel}` : label}
        </span>
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AggregateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[17px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1.5 text-[11px] leading-none text-muted-foreground">
        {label}
      </div>
    </div>
  );
}
