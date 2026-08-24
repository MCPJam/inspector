import { useMemo, useState } from "react";
import { FileUp, Loader2, MessageSquareText, Play, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
} from "./eval-surface-chrome";
import { getEffectiveSuiteServers } from "./helpers";
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
} from "./suite-detail-model";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "./types";

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

const VERDICT_TONE: Record<RunHistoryVerdict, string> = {
  ship: "bg-success/15 text-success",
  passed: "bg-success/15 text-success",
  hold: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  failed: "bg-destructive/15 text-destructive",
  running: "bg-muted text-muted-foreground",
  pending: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

function VerdictBadge({
  verdict,
  label,
}: {
  verdict: RunHistoryVerdict;
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        VERDICT_TONE[verdict],
      )}
    >
      {label}
    </span>
  );
}

export function SuiteDetailOverview({
  suite,
  cases,
  runs,
  runsLoading: _runsLoading,
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
  const filteredRows = useMemo(
    () => filterSuiteRunHistoryRows(historyRows, filters),
    [historyRows, filters],
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
  const showRunHistory = runs.length > 0;
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
        className={evalSurfaceCardClass}
        data-testid="suite-detail-run-history"
      >
        <div
          className={cn(
            evalSurfaceHeaderClass,
            "flex flex-wrap items-center justify-between gap-3 px-4 py-3",
          )}
        >
          <h3 className="text-sm font-semibold text-foreground">Run History</h3>
          {historyRows.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {filterOptions.verdicts.length > 0 ? (
                <FilterSelect
                  label="Verdict"
                  value={filters.verdict}
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
                  value={filters.client}
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
                  value={filters.model}
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
            className="grid gap-3 border-b border-border/40 px-4 py-3 sm:grid-cols-3 lg:grid-cols-6"
            data-testid="suite-detail-run-aggregates"
          >
            <AggregateStat label="Runs" value={String(aggregates.runCount)} />
            <AggregateStat
              label="Tokens"
              value={formatRunHistoryMetric(aggregates.totalTokens, "number")}
            />
            <AggregateStat
              label="Latency p50"
              value={formatRunHistoryMetric(aggregates.latencyP50, "duration")}
            />
            <AggregateStat
              label="Latency p95"
              value={formatRunHistoryMetric(aggregates.latencyP95, "duration")}
            />
            <AggregateStat
              label="Tokens / run"
              value={formatRunHistoryMetric(aggregates.tokensPerRun, "number")}
            />
            <AggregateStat
              label="Tool calls / run"
              value={formatRunHistoryMetric(aggregates.toolCallsPerRun, "number")}
            />
          </div>
        ) : null}

        {filteredRows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            No runs match these filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Top failure signature</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Tokens/run</TableHead>
                  <TableHead className="text-right">Tool calls/run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => (
                  <TableRow
                    key={row.runId}
                    data-testid={`suite-run-row-${row.runId}`}
                    className={cn("cursor-pointer", evalSurfaceRowHoverClass)}
                    onClick={() => onRunClick(row.runId)}
                  >
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {row.dateLabel}
                    </TableCell>
                    <TableCell>
                      <VerdictBadge
                        verdict={row.verdict}
                        label={row.verdictLabel}
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {row.passRate != null ? `${row.passRate}%` : "—"}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                      {row.topFailureSignature ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {row.platform}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatRunHistoryMetric(row.latencyMs, "duration")}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatRunHistoryMetric(row.tokens, "number")}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatRunHistoryMetric(row.toolCalls, "number")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {hiddenRunCount > 0 ? (
          <div className="border-t border-border/40 px-4 py-2.5">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAllRuns(true)}
            >
              view all {filteredRows.length} runs
            </button>
          </div>
        ) : null}
      </section>
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
          {!readOnlyConfig && onEditCases ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onEditCases}
            >
              Edit
            </Button>
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
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          aria-label={`Filter by ${label.toLowerCase()}`}
          className="h-7 w-[8.5rem] text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AggregateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}
