import { useMemo } from "react";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import type { EvaluateNavRoute } from "@/lib/eval-route-types";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { trackEvalNav } from "../nav/evaluate-nav-events";
import {
  ExecutionPreviewPanel,
  useExecutionPreviewToggle,
} from "../case-steps/execution-preview";
import { EvaluateNavCrumbBar } from "../nav/evaluate-nav-crumb-bar";
import { useEvaluateNavNavigate } from "../nav/use-evaluate-nav-navigate";
import { IterationReportScorecard } from "../case-scorecard/iteration-report-subscriber";
import { resultCounts, cellResult } from "../run-results-matrix-model";
import { CaseIterations } from "./case-iterations";
import { iterationAuthored } from "./iteration-evidence";
import { outcomeTextTone } from "./iteration-outcome";
import { TestRunFindings } from "./test-run-findings";
import {
  buildTestRunFindings,
  pickTarget,
  representativeIteration,
} from "./test-run-model";
import { useTestRunData } from "./use-test-run-data";

type TestRunRoute = Extract<EvaluateNavRoute, { type: "test-run" }>;

const VERDICT_WORD = {
  passed: "Passed",
  failed: "Failed",
  pending: "Running",
  cancelled: "Cancelled",
} as const;

/** One case inside one run (C11): findings, scorecard, iterations per model. */
export function TestRunPage({ route }: { route: TestRunRoute }) {
  const { suiteId, runId, caseId } = route;
  const navigate = useEvaluateNavNavigate();
  const preview = useExecutionPreviewToggle();
  const data = useTestRunData(route, { loadCase: preview.open });
  const { run, targets, iterations } = data;
  const target = pickTarget(targets, route.target);
  const targetItems = target?.cells.get(caseId) ?? [];
  const scorecardIteration = representativeIteration(targetItems);
  const findings = useMemo(
    () => buildTestRunFindings(data.diagnostics, caseId, iterations.length),
    [data.diagnostics, caseId, iterations.length],
  );
  const testCase = data.testCase;
  const previewInput = testCase && {
    steps: testCase.steps ?? [],
    predicates: testCase.predicates,
    expectedOutput: testCase.expectedOutput,
    suiteDefaultPredicates: data.suite?.defaultPredicates ?? [],
    suppressedSuiteStandardCheckIds: testCase.suppressedSuiteStandardCheckIds,
  };
  const editRoute = { type: "test-run-edit", suiteId, runId, caseId } as const;
  const openIteration = (iterationId: string) =>
    navigate(
      { type: "iteration", suiteId, runId, caseId, iterationId },
      "link",
    );

  const counts = resultCounts(iterations);
  const verdict = cellResult(iterations);
  const chain = data.diagnostics.find(
    (item) => item.iterationId === scorecardIteration?._id,
  )?.chain;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="test-run-page">
      <EvaluateNavCrumbBar
        route={route}
        names={{
          suiteName: data.suite?.name,
          caseName: data.caseTitle,
          runNumber: run?.runNumber,
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 px-5 py-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Test run{run ? ` · Run #${run.runNumber}` : ""}
              </div>
              <div className="flex items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight">
                  {data.caseTitle ?? "Test case"}
                </h1>
                {preview.button}
              </div>
              {verdict && (
                <p className="text-sm">
                  <span className={cn("font-medium", outcomeTextTone(verdict))}>
                    {VERDICT_WORD[verdict]}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {counts.passed}/{iterations.length} iterations passed
                  </span>
                </p>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => {
                trackEvalNav("eval_edit_from_test_run", { surface: "page" });
                navigate(editRoute, "link");
              }}
            >
              <Pencil aria-hidden="true" className="size-3.5" />
              Edit Test Case
            </Button>
          </header>
          <div
            className={cn(
              "grid gap-6",
              preview.open &&
                "lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]",
            )}
          >
            {preview.open && (
              <ExecutionPreviewPanel
                surface="test_run"
                input={previewInput}
                onClose={preview.close}
                onSelectStep={(stepIndex) => {
                  trackEvalNav("eval_edit_from_test_run", {
                    surface: "preview_step",
                  });
                  navigate(editRoute, "link", { focusStepIndex: stepIndex });
                }}
              />
            )}
            <div className="min-w-0 space-y-6">
              {data.isLoading || data.isRunLoading ? (
                <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading the test run…
                </div>
              ) : data.isRunUnavailable || !run ? (
                <p className="py-10 text-sm text-muted-foreground">
                  This run was deleted or you no longer have access to it.
                </p>
              ) : (
                <>
                  <TestRunFindings
                    findings={findings}
                    onOpenIteration={openIteration}
                  />
                  {scorecardIteration && (
                    <section aria-label="Scorecard" className="space-y-2">
                      <h2 className="text-sm font-semibold">
                        Scorecard{" "}
                        <span className="font-normal text-muted-foreground">
                          iteration #{scorecardIteration.iterationNumber ?? 1}
                        </span>
                      </h2>
                      <ScorecardFor
                        iteration={scorecardIteration}
                        run={run}
                        chain={chain}
                      />
                    </section>
                  )}
                  <section
                    aria-labelledby="test-run-iterations"
                    className="space-y-3 rounded-xl border border-border bg-card p-5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2
                        id="test-run-iterations"
                        className="text-sm font-semibold"
                      >
                        Iterations
                      </h2>
                      {targets.length > 1 && target && (
                        <ToggleGroup
                          type="single"
                          value={target.targetKey}
                          aria-label="Model"
                          className="gap-0.5 bg-muted p-0.5"
                          onValueChange={(value) =>
                            value &&
                            navigate({ ...route, target: value }, "link", {
                              replace: true,
                            })
                          }
                        >
                          {targets.map((item) => {
                            const itemCounts = resultCounts(
                              item.cells.get(caseId) ?? [],
                            );
                            return (
                              <ToggleGroupItem
                                key={item.key}
                                value={item.targetKey}
                                className="h-7 flex-none rounded-sm px-2.5 text-xs data-[state=on]:bg-card data-[state=on]:shadow-sm"
                              >
                                {item.model}{" "}
                                <span className="tabular-nums text-muted-foreground">
                                  {itemCounts.passed}/
                                  {(item.cells.get(caseId) ?? []).length}
                                </span>
                              </ToggleGroupItem>
                            );
                          })}
                        </ToggleGroup>
                      )}
                    </div>
                    {target ? (
                      <CaseIterations
                        target={target}
                        caseKey={caseId}
                        onSelectIteration={openIteration}
                      />
                    ) : (
                      <p className="py-6 text-sm text-muted-foreground">
                        No iterations of this case were recorded in this run.
                      </p>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The scorecard of one iteration, with the scorers its run recorded. */
function ScorecardFor({
  iteration,
  run,
  chain,
}: {
  iteration: EvalIteration;
  run: EvalSuiteRun;
  chain?: EvalRunDecisionChain;
}) {
  const authored = useMemo(
    () => iterationAuthored(iteration, run),
    [iteration, run],
  );
  return (
    <IterationReportScorecard
      authored={authored}
      iteration={iteration}
      steps={authored.steps}
      chain={chain}
    />
  );
}
