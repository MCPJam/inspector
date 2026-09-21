import {
  dependentFilterOptions,
  selectedFilter,
} from "../evals/filter-options";
import { groupProjectRuns } from "../evals/project-run-suite-groups";
import type { ProjectRunRow } from "../evals/project-runs-table";
import {
  EvaluateHistoryHeader,
  EvaluateHistoryRow,
} from "./evaluate-history-row";
import {
  EvalListFilter,
  ALL_EVAL_FILTER_VALUES,
} from "../evals/eval-list-filter";
import {
  RunHistoryTable,
  runHistorySurfaceClass,
  runHistoryToolbarClass,
  runHistoryFooterClass,
} from "../evals/run-history-table";
import {
  useEvalGeneration,
  evalSuiteKey,
  followAuthoringJob,
} from "@/lib/mcpjam-agent/eval-workspace";
import { SuiteRunReview, type SuiteRunReviewProps } from "./suite-run-review";
import { GenerateCasesDialog } from "./generate-cases-dialog";
import type { GenerateCasesConfig } from "@/lib/evals/eval-generation-config";
import { EvalGenerationWorkspace } from "./eval-generation-workspace";
import { EvalGeneratedDrafts } from "./eval-generated-drafts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Code2,
  FileUp,
  Loader2,
  MessageSquareText,
  Play,
  Sparkles,
  Plus,
  ChevronDown,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@mcpjam/design-system/dropdown-menu";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { toast } from "sonner";
import { TableBody } from "@mcpjam/design-system/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "../evals/eval-surface-chrome";
import { cancellableRunIds, getEffectiveSuiteServers } from "../evals/helpers";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "../evals/constants";
import {
  SUITE_RUN_HISTORY_PAGE_SIZE,
  buildSuiteRunHistoryRowsFromMetrics,
  buildSuiteTestCaseRows,
  suiteRunBlockedReason,
  runTimestamp,
} from "./suite-detail-model";
import type { EvalCase, EvalSuite, EvalSuiteRun } from "../evals/types";
import type { RunMetricsByRun } from "../evals/run-metrics";
import type { ProjectRunHistoryDetail } from "../evals/use-project-run-history";
import { SuiteRunHistorySnapshot } from "./suite-run-history-snapshot";
import { CI_OWNED_REASON_COPY } from "@/lib/evals/is-ci-owned-suite";

export const SUITE_EMPTY_CASES_TITLE = "No cases yet";
export const SUITE_EMPTY_CASES_DESCRIPTION =
  "Describe a behavior, generate from your servers' live discovery, or import an existing test file.";
export const SUITE_EMPTY_CASES_DESCRIPTION_NO_GENERATE =
  "Describe a behavior or import an existing test file.";

const EMPTY_CASE_ACTIONS = [
  {
    id: "describe",
    title: "Describe",
    description: "Tell us a behavior. Chat drafts the case",
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
    description: "Document → draft cases",
    Icon: FileUp,
  },
] as const;

export function SuiteDetailOverview({
  suite,
  runReviewRequested = false,
  onRunReviewClose,
  cases,
  runs,
  runsLoading,
  metricsByRun,
  hostNamesById,
  environments,
  onRerun,
  onEditSuite,
  onSetupSdk,
  onDuplicateSuite,
  onEditCases,
  onDescribeCases,
  onGenerateTestCases,
  canGenerateTestCases = false,
  generateTestCasesDisabledReason,
  isGeneratingTestCases = false,
  onImportCases,
  onDeleteTestCasesBatch,
  onRunClick,
  onTestCaseClick,
  onCancelRun,
  cancellingRunId = null,
  rerunningSuiteId,
  replayingRunId = null,
  runningTestCaseId = null,
  evalRunsDisabledReason = null,
  readOnlyConfig = false,
  configLocked = false,
  projectId = null,
  importJobId = null,
  onGeneratingChange,
}: {
  suite: EvalSuite;
  runReviewRequested?: boolean;
  onRunReviewClose?: () => void;
  cases: EvalCase[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  /** One metrics object per run — see `evals/run-metrics.ts`. */
  metricsByRun: RunMetricsByRun;
  hostNamesById: Map<string, string | null>;
  environments?: SuiteRunReviewProps["environments"];
  onRerun: SuiteRunReviewProps["onStart"];
  onEditSuite: () => void;
  onSetupSdk?: () => void;
  /**
   * Take an editable copy. Offered only when {@link configLocked} — it is the
   * one way forward for a suite the app refuses to edit, and offering it beside
   * an ordinary Edit button would just be a second, worse Edit.
   */
  onDuplicateSuite?: () => void;
  onEditCases?: () => void;
  onDescribeCases?: () => void;
  onGenerateTestCases?: (refinement?: string) => Promise<void> | void;
  canGenerateTestCases?: boolean;
  generateTestCasesDisabledReason?: string;
  isGeneratingTestCases?: boolean;
  onImportCases?: () => void;
  /**
   * Shared with the cross-host dashboard's row delete — same batch mutation,
   * same confirm copy. Absent (or suite read-only) hides the row trash button.
   */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  onRunClick: (runId: string) => void;
  onTestCaseClick: (testCaseId: string) => void;
  /**
   * Stops runs that are still going. Takes every cancellable id at once — the
   * header cancels the whole suite, a history row cancels its whole launch.
   */
  onCancelRun?: (runIds: readonly string[]) => void;
  cancellingRunId?: string | null;
  rerunningSuiteId: string | null;
  replayingRunId?: string | null;
  runningTestCaseId?: string | null;
  evalRunsDisabledReason?: string | null;
  readOnlyConfig?: boolean;
  /**
   * The suite is managed by CI: its configuration lives in a repository, so the
   * app refuses to edit it. Run and replay stay — see
   * `SuiteIterationsView.configLocked` on why this is not `readOnlyConfig`.
   */
  configLocked?: boolean;
  /** Threaded from `EvaluateTab`; never resolved in the browser. */
  projectId?: string | null;
  /**
   * An authoring job whose drafts this page should open on (`?importJob=`).
   *
   * An API import hands its unfinished cases back as a link, which a person
   * may open in a browser that never ran the import — so the drafts are read
   * from the job itself rather than from this tab's memory.
   */
  importJobId?: string | null;
  /** Retained for callers; verdicts are read in the report, not history rows. */
  decisionSummaryEnabled?: boolean;
  /**
   * Reports the case-generation view opening and closing, with the way back
   * out of it. Generation is local state rather than a route, so the header —
   * which builds the breadcrumb from the route alone — cannot otherwise know
   * the page changed under it, and its "Generate test cases" crumb would have
   * nothing to return to.
   */
  onGeneratingChange?: (
    state: { exit: () => void; label?: string } | null,
  ) => void;
}) {
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const [clientFilter, setClientFilter] = useState(ALL_EVAL_FILTER_VALUES);
  const [modelFilter, setModelFilter] = useState(ALL_EVAL_FILTER_VALUES);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [reviewRun, setReviewRun] = useState(false);
  const [caseToDelete, setCaseToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [isDeletingCase, setIsDeletingCase] = useState(false);

  const confirmDeleteCase = async () => {
    if (!caseToDelete || !onDeleteTestCasesBatch) return;
    setIsDeletingCase(true);
    try {
      await onDeleteTestCasesBatch([caseToDelete.id]);
      toast.success("Test case deleted");
      setCaseToDelete(null);
    } catch (error) {
      console.error("Failed to delete test case:", error);
      toast.error("Failed to delete test case");
    } finally {
      setIsDeletingCase(false);
    }
  };

  const historyRows = useMemo(
    () =>
      buildSuiteRunHistoryRowsFromMetrics(
        runs,
        metricsByRun,
        suite,
        hostNamesById,
        projectEnvironmentsEnabled,
      ),
    [runs, metricsByRun, suite, hostNamesById, projectEnvironmentsEnabled],
  );
  const filterOptions = useMemo(() => {
    const options = dependentFilterOptions(historyRows, {
      clients: {
        selected: selectedFilter(clientFilter),
        values: (row) => (row.client ? [row.client] : []),
      },
      models: {
        selected: selectedFilter(modelFilter),
        values: (row) => row.models,
      },
    });
    return { clients: options.clients, models: options.models };
  }, [historyRows, clientFilter, modelFilter]);
  // Derived once per data/filter change. `details` and the filtered launches
  // are passed down as props, so fresh identities on every local state change
  // (opening the review dialog, toggling "show all") defeated the children's
  // own memoization and regrouped every run for nothing.
  const {
    details,
    effectiveClient,
    effectiveModel,
    rowMap,
    filteredRows,
    visibleRows,
    hiddenRunCount,
    filteredRunIds,
  } = useMemo(() => {
    const details = new Map<string, ProjectRunHistoryDetail>(
      runs.map((run) => [
        run._id,
        {
          run,
          iterations: [],
          metrics: metricsByRun.get(run._id) ?? null,
        },
      ]),
    );
    const projectRows: ProjectRunRow[] = runs.map((run) => ({
      _id: run._id,
      suiteId: run.suiteId,
      suiteName: suite.name,
      suiteSource: suite.source ?? null,
      runNumber: run.runNumber,
      status: run.status,
      result: run.result,
      summary: run.summary ?? null,
      source: run.source ?? null,
      ciMetadata: run.ciMetadata ?? null,
      createdBy: run.createdBy,
      createdByName: null,
      createdByImageUrl: null,
      createdAt: runTimestamp(run),
      completedAt: run.completedAt ?? null,
      durationMs: null,
    }));
    const launches = groupProjectRuns(projectRows, details).flatMap(
      (group) => group.launches,
    );
    const effectiveClient = filterOptions.clients.includes(clientFilter)
      ? clientFilter
      : ALL_EVAL_FILTER_VALUES;
    const effectiveModel = filterOptions.models.includes(modelFilter)
      ? modelFilter
      : ALL_EVAL_FILTER_VALUES;
    const rowMap = new Map(historyRows.map((row) => [row.runId, row]));
    // Filters select whole runs; pairings remain together in their report.
    const filteredRows = launches.filter((launch) =>
      launch.runs.some((run) => {
        const row = rowMap.get(run._id);
        return (
          row &&
          (effectiveClient === ALL_EVAL_FILTER_VALUES ||
            row.client === effectiveClient) &&
          (effectiveModel === ALL_EVAL_FILTER_VALUES ||
            row.models.includes(effectiveModel))
        );
      }),
    );
    const visibleRows = showAllRuns
      ? filteredRows
      : filteredRows.slice(0, SUITE_RUN_HISTORY_PAGE_SIZE);
    const hiddenRunCount = filteredRows.length - visibleRows.length;
    const filteredRunIds = new Set(
      filteredRows.flatMap((launch) => launch.runs.map((run) => run._id)),
    );
    return {
      details,
      effectiveClient,
      effectiveModel,
      rowMap,
      filteredRows,
      visibleRows,
      hiddenRunCount,
      filteredRunIds,
    };
  }, [
    runs,
    metricsByRun,
    suite,
    historyRows,
    filterOptions,
    clientFilter,
    modelFilter,
    showAllRuns,
  ]);

  const testCaseRows = useMemo(() => buildSuiteTestCaseRows(cases), [cases]);

  const isEnvironmentSuite = (suite.environmentIds?.length ?? 0) > 0;
  const hasServersConfigured = getEffectiveSuiteServers(suite).length > 0;
  const isRerunning = rerunningSuiteId === suite._id;
  const generation = useEvalGeneration((state) =>
    projectId && !readOnlyConfig
      ? state.suites[evalSuiteKey({ projectId, suiteId: suite._id })]
      : undefined,
  );
  const runBlockedReason = suiteRunBlockedReason({
    caseCount: cases.length,
    draftCount: generation?.drafts.length ?? 0,
    hasServersConfigured,
    isEnvironmentSuite,
    isRerunning,
    isReplaying: replayingRunId != null,
    runningTestCase: runningTestCaseId != null,
    evalRunsDisabledReason,
  });
  const runDisabled = Boolean(runBlockedReason);
  const hasCases = cases.length > 0;
  const canDeleteCases = Boolean(
    onDeleteTestCasesBatch && !readOnlyConfig && !configLocked,
  );
  /**
   * Hide the card until there is something to put in it. A never-run suite
   * already has Test Cases (or the empty-cases hero) — an empty history table
   * above that is scaffolding.
   *
   * `runsLoading` still counts on its own: runs resolve AFTER the detail
   * spinner clears (`isSuiteRunsLoading` is its own query), and the frame has
   * to be held for a suite that has runs rather than popped in under the
   * reader.
   */
  const showRunHistory = runs.length > 0 || runsLoading;
  const hasRuns = runs.length > 0;
  const hasGeneratedContent =
    Boolean(generation?.drafts.length) || generation?.status === "running";
  const showEmptyCasesHero = !hasCases && !hasGeneratedContent;

  /**
   * Imported drafts get their OWN surface, the way generation does. They are
   * not in the suite and cannot run, so listing them beside real cases invited
   * exactly one reading: that the import had already landed.
   *
   * What marks a draft as imported is document provenance: the authoring job
   * cites the file it read. Generation invents cases from the suite's tools and
   * has nothing to cite, so it never reaches this surface.
   */
  const importedDrafts =
    generation?.drafts.filter((draft) => draft.authoring?.source) ?? [];
  const [importReviewClosed, setImportReviewClosed] = useState(false);
  useEffect(() => {
    // Linked-to jobs are followed, not assumed: the poll stages whatever the
    // job still holds, and committed drafts are already excluded from it, so
    // the surface opens on exactly the cases that still need a person.
    if (!projectId || !importJobId) return;
    void followAuthoringJob({ projectId, suiteId: suite._id }, importJobId);
  }, [projectId, importJobId, suite._id]);
  const hadImportedDrafts = useRef(importedDrafts.length > 0);
  useEffect(() => {
    // A fresh import reopens the review; leaving it closed would strand the
    // drafts with no way back to them.
    if (importedDrafts.length && !hadImportedDrafts.current)
      setImportReviewClosed(false);
    hadImportedDrafts.current = importedDrafts.length > 0;
  }, [importedDrafts.length]);
  const reviewingImport = Boolean(
    projectId && importedDrafts.length && !importReviewClosed,
  );
  const exitImportReview = useCallback(() => setImportReviewClosed(true), []);
  useEffect(() => {
    if (!reviewingImport) return;
    onGeneratingChange?.({
      exit: exitImportReview,
      label: "Import test cases",
    });
    return () => onGeneratingChange?.(null);
  }, [reviewingImport, exitImportReview, onGeneratingChange]);

  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationConfig, setGenerationConfig] =
    useState<GenerateCasesConfig>();
  const handleGenerateCases = () => {
    if (projectId) setGenerationOpen(true);
  };
  // Generation needs a project to run against; without one the button can
  // only fail silently.
  const canGenerate = canGenerateTestCases && Boolean(projectId);

  const generating = Boolean(generationConfig && projectId);
  const exitGeneration = useCallback(() => setGenerationConfig(undefined), []);
  /**
   * Back to the suite WITH the scope dialog open. Reopening it in place would
   * not show: the generation view returns before the dialog is rendered.
   */
  const changeGenerationSettings = useCallback(() => {
    setGenerationConfig(undefined);
    setGenerationOpen(true);
  }, []);
  useEffect(() => {
    if (!generating) return;
    onGeneratingChange?.({ exit: exitGeneration });
    return () => onGeneratingChange?.(null);
  }, [generating, exitGeneration, onGeneratingChange]);

  const cancellableIds = cancellableRunIds(runs);
  // Spinner only. The DISABLED state is the wider `cancellingRunId !== null`:
  // the shared handler refuses a second cancel while one is in flight, so a
  // sibling row left enabled is a button that quietly does nothing.
  const isCancelling = cancellableIds.some((id) => id === cancellingRunId);
  const cancelButton =
    onCancelRun && cancellableIds.length > 0 ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        data-testid="suite-detail-cancel"
        aria-label="Cancel run"
        disabled={cancellingRunId !== null}
        onClick={() => onCancelRun(cancellableIds)}
      >
        {isCancelling ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : null}
        Cancel run
      </Button>
    ) : null;

  const runButton = (
    <Button
      type="button"
      size="sm"
      className="h-8 gap-1.5"
      disabled={runDisabled}
      aria-label="Setup Run"
      aria-busy={isRerunning}
      onClick={() => setReviewRun(true)}
    >
      {isRerunning ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      ) : (
        <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      Setup Run
    </Button>
  );

  if (generationConfig && projectId)
    return (
      <EvalGenerationWorkspace
        key={`${projectId}:${suite._id}`}
        config={generationConfig}
        projectId={projectId}
        suiteId={suite._id}
        suiteName={suite.name}
        onChangeSettings={changeGenerationSettings}
        onDone={exitGeneration}
      />
    );

  if (reviewingImport && projectId)
    return (
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-8"
        data-testid="suite-import-review"
      >
        <div className="mx-auto w-full max-w-5xl">
          <EvalGeneratedDrafts
            key={`${projectId}:${suite._id}:import`}
            projectId={projectId}
            suiteId={suite._id}
            suiteName={suite.name}
          />
        </div>
      </div>
    );

  return (
    <div
      className={cn(
        // Keep intrinsic height inside the scroll pane; a long case list
        // otherwise squeezes the overflow-hidden history card to its borders.
        "flex min-h-full shrink-0 flex-col gap-4 pb-6",
        showEmptyCasesHero && !showRunHistory && "flex-1",
      )}
      data-testid="suite-detail-overview"
    >
      {generationOpen && (
        <GenerateCasesDialog
          key={suite._id}
          suiteId={suite._id}
          onClose={() => setGenerationOpen(false)}
          onGenerate={(config) => {
            setGenerationOpen(false);
            setGenerationConfig(config);
          }}
        />
      )}
      {(reviewRun || runReviewRequested) && (
        <SuiteRunReview
          projectId={projectId}
          key={suite._id}
          suite={suite}
          cases={cases}
          environments={environments}
          hostNamesById={hostNamesById}
          onClose={() => {
            setReviewRun(false);
            onRunReviewClose?.();
          }}
          onStart={onRerun}
          onEditSettings={readOnlyConfig ? undefined : onEditSuite}
          disabledReason={runBlockedReason}
        />
      )}
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
          {onSetupSdk && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onSetupSdk}
            >
              <Code2 className="size-3.5" aria-hidden /> Setup SDK
            </Button>
          )}
          {configLocked ? (
            // The reason and the way out, together. A disabled Edit button with
            // a tooltip would make the remedy discoverable only by hovering the
            // thing that does not work.
            <span
              className="text-xs text-muted-foreground"
              data-testid="suite-detail-ci-owned"
            >
              {CI_OWNED_REASON_COPY}
            </span>
          ) : !readOnlyConfig ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onEditSuite}
            >
              Configure suite evaluators
            </Button>
          ) : null}
          {configLocked && onDuplicateSuite ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onDuplicateSuite}
              data-testid="suite-detail-duplicate-to-edit"
            >
              Duplicate to edit
            </Button>
          ) : null}
          {cancelButton}
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
          className={runHistorySurfaceClass}
          data-testid="suite-detail-run-history"
        >
          <div className={runHistoryToolbarClass}>
            <h3 className="text-xs font-semibold text-foreground">Runs</h3>
            {historyRows.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {filterOptions.clients.length > 0 && (
                  <EvalListFilter
                    label="Client"
                    value={effectiveClient}
                    options={filterOptions.clients}
                    onChange={setClientFilter}
                  />
                )}
                {filterOptions.models.length > 0 && (
                  <EvalListFilter
                    label="Model"
                    value={effectiveModel}
                    options={filterOptions.models}
                    onChange={setModelFilter}
                  />
                )}
              </div>
            ) : null}
          </div>

          <SuiteRunHistorySnapshot
            runs={runs.filter((run) => filteredRunIds.has(run._id))}
            metricsByRun={metricsByRun}
          />

          {filteredRows.length === 0 ? (
            <div
              className="bg-card px-5 py-10 text-center text-sm text-muted-foreground"
              data-testid="suite-run-history-empty"
            >
              {runsLoading
                ? "Loading runs…"
                : hasRuns
                ? "No runs match these filters."
                : "No runs yet."}
            </div>
          ) : (
            <div className="@container/run-history overflow-x-auto bg-card">
              <RunHistoryTable aria-label="Suite run history">
                <EvaluateHistoryHeader />
                <TableBody>
                  {visibleRows.map((launch) => {
                    const representative = [...launch.runs].sort(
                      (a, b) =>
                        a.runNumber - b.runNumber || a._id.localeCompare(b._id),
                    )[0];
                    return (
                      <EvaluateHistoryRow
                        key={launch.key}
                        testId={`suite-run-row-${representative._id}`}
                        rows={launch.runs}
                        details={details}
                        historyRows={rowMap}
                        hostNamesById={hostNamesById}
                        onOpen={() => onRunClick(representative._id)}
                      />
                    );
                  })}
                </TableBody>
              </RunHistoryTable>
            </div>
          )}

          {hiddenRunCount > 0 ? (
            <div className={runHistoryFooterClass}>
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setShowAllRuns(true)}
              >
                view all {filteredRows.length.toLocaleString()} runs →
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {showEmptyCasesHero ? (
        <SuiteEmptyCasesHero
          readOnly={readOnlyConfig || configLocked}
          onDescribe={onDescribeCases ?? onEditCases}
          onGenerate={() => void handleGenerateCases()}
          canGenerate={canGenerate}
          generateDisabledReason={generateTestCasesDisabledReason}
          isGenerating={isGeneratingTestCases}
          onImport={onImportCases}
          fillRemaining={!showRunHistory}
        />
      ) : hasCases ? (
        <section
          className={evalSurfaceCardClass}
          data-testid="suite-detail-test-cases"
        >
          <div
            className={cn(
              evalSurfaceHeaderClass,
              "flex items-center justify-between gap-3 bg-muted/55 px-4 py-3",
            )}
          >
            <h3 className="text-sm font-semibold text-foreground">
              Test Cases
            </h3>
            {!readOnlyConfig && !configLocked ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="sm" className="h-8 gap-1.5">
                    <Plus className="size-3.5" aria-hidden /> Add case
                    <ChevronDown className="size-3.5" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  {(onDescribeCases ?? onEditCases) && (
                    <DropdownMenuItem onSelect={onDescribeCases ?? onEditCases}>
                      Describe
                    </DropdownMenuItem>
                  )}
                  {onGenerateTestCases && (
                    <DropdownMenuItem
                      disabled={!canGenerate || isGeneratingTestCases}
                      onSelect={() => void handleGenerateCases()}
                    >
                      {isGeneratingTestCases ? "Generating…" : "Generate"}
                    </DropdownMenuItem>
                  )}
                  {onGenerateTestCases &&
                    (!canGenerate || isGeneratingTestCases) &&
                    generateTestCasesDisabledReason && (
                      <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                        {generateTestCasesDisabledReason}
                      </p>
                    )}
                  {onImportCases && (
                    <DropdownMenuItem onSelect={onImportCases}>
                      Import
                    </DropdownMenuItem>
                  )}
                  {onEditCases && (
                    <DropdownMenuItem onSelect={onEditCases}>
                      Add manually
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          <ul className="divide-y divide-border/40">
            {testCaseRows.map((row) => (
              <li
                key={row.caseId}
                className={cn(
                  "group flex items-center gap-1 pr-2",
                  evalSurfaceRowHoverClass,
                )}
              >
                <button
                  type="button"
                  data-testid={`suite-test-case-row-${row.caseId}`}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left"
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
                {canDeleteCases ? (
                  <button
                    type="button"
                    data-testid={`suite-test-case-delete-${row.caseId}`}
                    onClick={() =>
                      setCaseToDelete({ id: row.caseId, title: row.title })
                    }
                    title="Delete test case"
                    aria-label={`Delete test case: ${row.title}`}
                    className="shrink-0 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : !readOnlyConfig ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onDescribeCases ?? onEditCases}
          >
            Describe another case
          </Button>
          {onGenerateTestCases && (
            <GenerateCasesButton
              onGenerate={handleGenerateCases}
              canGenerate={canGenerate}
              disabledReason={generateTestCasesDisabledReason}
              isGenerating={
                isGeneratingTestCases || generation?.status === "running"
              }
            />
          )}
          {onImportCases && (
            <Button variant="outline" size="sm" onClick={onImportCases}>
              Import cases
            </Button>
          )}
        </div>
      ) : null}

      <Dialog
        open={caseToDelete != null}
        onOpenChange={(open) => {
          if (!open && !isDeletingCase) setCaseToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-destructive" aria-hidden />
              Delete test case
            </DialogTitle>
            <DialogDescription>
              Delete “{caseToDelete?.title || "Untitled test case"}”? This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCaseToDelete(null)}
              disabled={isDeletingCase}
            >
              Cancel
            </Button>
            <Button
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
              data-testid="suite-test-case-delete-confirm"
              onClick={confirmDeleteCase}
              disabled={isDeletingCase}
            >
              {isDeletingCase ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    ? disabledReason ?? "Configure suite servers before generating cases."
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

export function SuiteEmptyCasesHero({
  readOnly,
  onDescribe,
  onGenerate,
  canGenerate,
  generateDisabledReason,
  isGenerating,
  onImport,
  fillRemaining,
  hideGenerate = false,
}: {
  readOnly: boolean;
  onDescribe?: () => void;
  onGenerate?: () => void;
  canGenerate: boolean;
  generateDisabledReason?: string;
  isGenerating: boolean;
  onImport?: () => void;
  fillRemaining: boolean;
  /** First-run already generated. Only Describe and Import remain. */
  hideGenerate?: boolean;
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
    onImport?.();
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
        {hideGenerate
          ? SUITE_EMPTY_CASES_DESCRIPTION_NO_GENERATE
          : SUITE_EMPTY_CASES_DESCRIPTION}
      </p>
      {!readOnly ? (
        <div className="mt-6 flex w-full max-w-2xl flex-col gap-3 sm:flex-row">
          {EMPTY_CASE_ACTIONS.filter(
            (action) => !hideGenerate || action.id !== "generate",
          ).map((action) => {
            const disabled =
              action.id === "describe"
                ? !onDescribe
                : action.id === "generate"
                ? !onGenerate || !canGenerate || isGenerating
                : !onImport;
            const generateTooltip =
              action.id === "generate"
                ? isGenerating
                  ? "Generating test cases…"
                  : !canGenerate
                  ? generateDisabledReason ??
                    "Configure suite servers before generating cases."
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
                    <Loader2
                      className="size-4 shrink-0 animate-spin"
                      aria-hidden
                    />
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
