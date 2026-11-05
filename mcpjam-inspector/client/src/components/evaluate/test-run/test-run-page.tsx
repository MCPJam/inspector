/**
 * Test run: one test case inside one suite run, as a page (spec C11, C13).
 *
 * Verdict, the run's findings about this case, every check counted across
 * the case's iterations, and the iterations per model. The diamond beside
 * the title docks the case's execution preview; Edit Test Case opens the
 * editor under this test run (D13).
 */
import { useMemo, useState } from "react";
import { Diamond, Loader2, Pencil } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import type { EvalRoute } from "@/lib/eval-route-types";
import { useServerQuality } from "../../evals/use-server-quality";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import {
  buildExecutionPreview,
  type EditorAnchor,
} from "../case-steps/case-steps-model";
import { launchRuns, resultCounts } from "../run-results-matrix-model";
import { UnifiedFindingsSection } from "../unified-findings-section";
import { trackEvalNav } from "../nav/eval-nav-events";
import { CaseIterations } from "./case-iterations";
import { ExecutionPreviewPanel } from "./execution-preview-panel";
import {
  caseIterations,
  caseScorecardInput,
  selectTestRunTarget,
  testRunTargets,
  testRunVerdict,
} from "./test-run-model";
import { buildTestRunScorecard } from "./test-run-scorecard-model";
import { TestRunScorecardTable } from "./test-run-scorecard";
import { useEvalNavPageView } from "./use-eval-nav-page-view";
import { useTestRunIterations } from "./use-test-run-iterations";

type TestRunRoute = Extract<EvalRoute, { type: "test-run" }>;

const VERDICT_TONE = {
  passed: "text-success",
  failed: "text-destructive",
  pending: "text-pending",
  muted: "text-muted-foreground",
} as const;

export function TestRunPage({
  route,
  projectId,
  suite,
  testCase,
  run,
  runs,
  hostNamesById,
}: {
  route: TestRunRoute;
  projectId: string | null | undefined;
  suite: EvalSuite;
  /** Null when the case was deleted after the run. */
  testCase: EvalCase | null;
  run: EvalSuiteRun;
  /** The suite's runs, for the launch's other models. */
  runs: readonly EvalSuiteRunListItem[];
  hostNamesById?: ReadonlyMap<string, string | null>;
}) {
  const { suiteId, runId, testCaseId } = route;
  useEvalNavPageView("test-run", `${runId}:${testCaseId}`);

  const launch = useMemo(
    () => launchRuns<EvalSuiteRunListItem>(run, runs),
    [run, runs],
  );
  const runIds = useMemo(() => launch.map((item) => item._id), [launch]);
  const read = useTestRunIterations(runIds, testCaseId);
  const iterations = read.iterations;
  const targets = useMemo(
    () =>
      testRunTargets({
        run,
        runs,
        iterations: iterations ?? [],
        hostNamesById,
      }),
    [run, runs, iterations, hostNamesById],
  );
  const selected = selectTestRunTarget(targets, route.target);
  const verdict = testRunVerdict(iterations ?? []);

  const active = Boolean(projectId) && isTerminalEvalRunStatus(run.status);
  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: run._id,
    enabled: active,
    revision: evalRunDecisionRevision(run),
  });
  const chains = useEvalRunIterationChains({ projectId, run, enabled: active });
  const serverQuality = useServerQuality(run, { autoRequest: false });

  const scorecard = useMemo(
    () =>
      buildTestRunScorecard({
        iterations: iterations ?? [],
        runFor: (iteration) =>
          launch.find((item) => item._id === iteration.suiteRunId) ?? null,
        chainFor: (iteration) =>
          detail.diagnostics.find((item) => item.iterationId === iteration._id)
            ?.chain ?? chains.chains.get(iteration._id),
      }),
    [iterations, launch, detail.diagnostics, chains.chains],
  );
  const caseIterationIds = useMemo(
    () => new Set((iterations ?? []).map((iteration) => iteration._id)),
    [iterations],
  );

  const previewItems = useMemo(() => {
    if (!testCase) return null;
    const input = caseScorecardInput(testCase, suite);
    return buildExecutionPreview(input.steps, buildCaseScorecard(input));
  }, [testCase, suite]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const togglePreview = () => {
    if (!previewOpen) {
      trackEvalNav("eval_execution_preview_opened", { surface: "test_run" });
    }
    setPreviewOpen(!previewOpen);
  };

  const openIteration = (iterationId: string) =>
    navigatePlaygroundEvalsRoute({
      type: "iteration",
      suiteId,
      runId,
      testCaseId,
      iterationId,
    });
  const editCase = (surface: "page" | "preview_step", step?: EditorAnchor) => {
    trackEvalNav("eval_edit_from_test_run", { surface });
    navigatePlaygroundEvalsRoute({
      type: "test-run-edit",
      suiteId,
      runId,
      testCaseId,
      ...(step ? { step } : {}),
    });
  };
  const selectTarget = (targetKey: string) =>
    navigatePlaygroundEvalsRoute(
      { ...route, target: targetKey },
      { replace: true },
    );

  const title =
    testCase?.title ?? iterations?.[0]?.testCaseSnapshot?.title ?? "Test case";
  const runLabel = run.runNumber != null ? `Run #${run.runNumber}` : "Run";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6"
      data-testid="test-run-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Test run · {runLabel}
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-2xl font-bold tracking-tight">
              {title}
            </h2>
            <Button
              variant="outline"
              size="icon"
              className={cn("size-8 shrink-0", previewOpen && "bg-muted")}
              aria-pressed={previewOpen}
              aria-label={
                previewOpen
                  ? "Hide execution preview"
                  : "Show execution preview"
              }
              title={
                previewItems
                  ? "Execution preview"
                  : "This test case was deleted, so there is nothing to preview."
              }
              disabled={!previewItems}
              onClick={togglePreview}
              data-testid="test-run-preview-toggle"
            >
              <Diamond
                className={cn("size-4", previewOpen && "fill-current")}
                aria-hidden
              />
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">
            <span className={cn("font-semibold", VERDICT_TONE[verdict.tone])}>
              {verdict.word}
            </span>
            {verdict.total > 0
              ? ` · ${verdict.passed}/${verdict.total} iterations passed`
              : null}
          </p>
        </div>
        {testCase ? (
          <Button variant="outline" onClick={() => editCase("page")}>
            <Pencil className="size-3.5" aria-hidden />
            Edit Test Case
          </Button>
        ) : null}
      </header>

      <div
        className={cn(
          "mt-6 grid min-w-0 gap-6",
          previewOpen && previewItems && "lg:grid-cols-[360px_minmax(0,1fr)]",
        )}
      >
        {previewOpen && previewItems ? (
          <div className="lg:sticky lg:top-0 lg:self-start">
            <ExecutionPreviewPanel
              items={previewItems}
              onOpenStep={(anchor) => editCase("preview_step", anchor)}
              onClose={() => setPreviewOpen(false)}
            />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-6">
          {iterations === undefined ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading this test run…
            </p>
          ) : read.failed ? (
            <p role="alert" className="text-sm">
              Couldn't load this test run's iterations. Reload the page to try
              again.
            </p>
          ) : (
            <>
              <UnifiedFindingsSection
                suiteRunId={String(run._id)}
                iterations={iterations}
                onlyIterationIds={caseIterationIds}
                generation={{
                  pending: serverQuality.pending,
                  failedGeneration: serverQuality.failedGeneration,
                  error: serverQuality.error,
                  unavailable: serverQuality.unavailable,
                  canRequest: serverQuality.canRequest,
                  requestInsight: serverQuality.requestServerQuality,
                }}
                onOpenIteration={(iterationId) => {
                  if (caseIterationIds.has(iterationId)) {
                    openIteration(iterationId);
                  }
                }}
              />
              <TestRunScorecardTable
                scorecard={scorecard}
                onOpenIteration={openIteration}
              />
              <TestRunIterationsCard
                targets={targets}
                selectedKey={selected?.key ?? null}
                testCaseId={testCaseId}
                truncated={read.truncated}
                onSelectTarget={selectTarget}
                onOpenIteration={openIteration}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TestRunIterationsCard({
  targets,
  selectedKey,
  testCaseId,
  truncated,
  onSelectTarget,
  onOpenIteration,
}: {
  targets: ReturnType<typeof testRunTargets>;
  selectedKey: string | null;
  testCaseId: string;
  truncated: boolean;
  onSelectTarget: (targetKey: string) => void;
  onOpenIteration: (iterationId: string) => void;
}) {
  const selected = targets.find((target) => target.key === selectedKey);
  return (
    <section
      className="rounded-xl border border-border bg-card px-6 py-5"
      aria-labelledby="test-run-iterations"
      data-testid="test-run-iterations"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 id="test-run-iterations" className="text-[15px] font-semibold">
          Iterations
        </h3>
        {targets.length > 1 ? (
          <ToggleGroup
            type="single"
            value={selectedKey ?? ""}
            onValueChange={(value) => {
              const target = targets.find((item) => item.key === value);
              if (target) onSelectTarget(target.targetKey);
            }}
            aria-label="Model"
            className="gap-0.5 bg-muted p-0.5"
            data-testid="test-run-model-picker"
          >
            {targets.map((target) => {
              const items = caseIterations(target, testCaseId);
              return (
                <ToggleGroupItem
                  key={target.key}
                  value={target.key}
                  className="h-7 min-w-0 flex-none gap-1.5 rounded-sm px-2.5 text-xs font-medium text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-card-foreground data-[state=on]:shadow-sm first:rounded-sm last:rounded-sm"
                >
                  {target.model}
                  <span className="tabular-nums">
                    {resultCounts(items).passed}/{items.length}
                  </span>
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        ) : null}
      </div>
      {selected ? (
        <CaseIterations
          target={selected}
          caseKey={testCaseId}
          onSelectIteration={onOpenIteration}
        />
      ) : (
        <p className="py-6 text-sm text-muted-foreground">
          This run recorded no iterations for this test case.
        </p>
      )}
      {truncated ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the first iterations of a long run.
        </p>
      ) : null}
    </section>
  );
}
