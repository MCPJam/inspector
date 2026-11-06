/**
 * Test run: one test case inside one suite run, across the launch's models.
 * Loads its own data and draws its own crumb bar; the body is TestRunView.
 */
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import { buildEvaluatePath, useAppNavigate } from "@/lib/app-navigation";
import type { EvalRoute } from "@/lib/eval-route-types";
import { EvalCrumbBar } from "@/components/evaluate/evals-header";
import { stripTimestampSuffix } from "../../evals/suite-overview-presentation";
import { computeIterationResult } from "../../evals/pass-criteria";
import { resultCounts } from "../run-results-matrix-model";
import { buildExecutionPreview } from "../case-steps/case-steps-model";
import {
  ExecutionPreviewPanel,
  useExecutionPreviewOpen,
} from "../case-steps/execution-preview-panel";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import {
  buildEvalBack,
  buildEvalCrumbs,
  evalNavPlace,
  type EvalNavNames,
} from "../nav/eval-nav-crumbs";
import { useEvalNavArrival, useEvalNavigate } from "../nav/eval-nav-state";
import { trackEvalNav, useEvalNavPageView } from "../nav/eval-nav-analytics";
import {
  buildTestRunFindings,
  testRunFixPrompt,
  testRunVerdict,
  type TestRunFinding,
} from "./test-run-findings-model";
import {
  buildTestRunScorecard,
  iterationScorecardGroups,
} from "./test-run-scorecard-model";
import { executionPreviewInputFor } from "./test-run-preview-input";
import { testRunEditPath } from "./test-run-links";
import { useTestRunData } from "./use-test-run-data";
import { useTestRunDecisions } from "./use-test-run-decisions";
import {
  TestRunScrollArea,
  TestRunSkeleton,
  TestRunView,
} from "./test-run-view";

type TestRunRoute = Extract<EvalRoute, { type: "test-run" }>;

export function TestRunPage({ route, projectId }: EvalNavPageProps) {
  if (route.type !== "test-run") return null;
  return <TestRunPageBody route={route} projectId={projectId} />;
}

async function copyFixPrompt(text: string) {
  if (await copyToClipboard(text)) {
    toast.success("Fix prompt copied. Paste it into your coding agent");
  } else {
    toast.error("Copy failed");
  }
}

function TestRunPageBody({
  route,
  projectId,
}: {
  route: TestRunRoute;
  projectId: string | null;
}) {
  const { suiteId, runId, testCaseId } = route;
  const ids = useMemo(
    () => ({ suiteId, runId, testCaseId }),
    [suiteId, runId, testCaseId],
  );
  const data = useTestRunData(ids);
  const decisions = useTestRunDecisions(
    projectId,
    data.launchRuns,
    data.iterations,
  );
  const arrival = useEvalNavArrival();
  const navigateEval = useEvalNavigate();
  const navigate = useAppNavigate();
  // The model switch rewrites ?target=; it is the same page, so one view.
  const viewRoute = useMemo<TestRunRoute>(
    () => ({ ...ids, type: "test-run" }),
    [ids],
  );
  useEvalNavPageView(viewRoute, { projectId, ui: "nav", enabled: true });

  const names: EvalNavNames = {
    suiteName: data.suite ? stripTimestampSuffix(data.suite.name) : undefined,
    runNumber: data.run?.runNumber,
    testCaseTitle: data.status === "loading" ? undefined : data.title,
  };
  const crumbs = buildEvalCrumbs(route, names) ?? [];
  const back = buildEvalBack(route, names, arrival.from);
  const from = { route, names };

  const { iterations, launchRuns } = data;
  const findings = useMemo(
    () => buildTestRunFindings(decisions.rows, iterations.length),
    [decisions.rows, iterations.length],
  );
  const scorecard = useMemo(
    () =>
      buildTestRunScorecard(
        iterations.flatMap((iteration) => {
          const run = launchRuns.find(
            (item) => item._id === iteration.suiteRunId,
          );
          if (!run || computeIterationResult(iteration) === "pending")
            return [];
          const decision = decisions.byRun.get(run._id);
          const chain =
            decision?.diagnostics.find(
              (item) => item.iterationId === iteration._id,
            )?.chain ??
            decision?.chains.get(iteration._id) ??
            null;
          return [
            {
              iteration,
              groups: iterationScorecardGroups({ iteration, run, chain }),
            },
          ];
        }),
      ),
    [iterations, launchRuns, decisions.byRun],
  );
  const previewItems = useMemo(
    () =>
      data.testCase && data.suite
        ? buildExecutionPreview(
            executionPreviewInputFor(data.testCase, data.suite),
          )
        : null,
    [data.testCase, data.suite],
  );
  const [previewOpen, setPreviewOpen] = useExecutionPreviewOpen();

  const targets = useMemo(() => {
    const all = data.matrix?.targets ?? [];
    const ran = all.filter(
      (target) => (target.cells.get(testCaseId) ?? []).length > 0,
    );
    return ran.length > 0 ? ran : all;
  }, [data.matrix, testCaseId]);
  const selectedTarget =
    targets.find((target) => target.targetKey === route.target) ??
    targets[0] ??
    null;

  const onSelectTarget = useCallback(
    (targetKey: string) => {
      // Replace, keeping the arrival state, so Back still names where you came from.
      navigate(
        buildEvaluatePath({ ...ids, type: "test-run", target: targetKey }),
        {
          replace: true,
          state:
            arrival.via === "direct"
              ? undefined
              : {
                  evalNav: {
                    via: arrival.via,
                    ...(arrival.from ? { from: arrival.from } : {}),
                  },
                },
        },
      );
    },
    [navigate, ids, arrival],
  );
  const openIteration = (iterationId: string) =>
    navigateEval(
      { ...ids, type: "iteration", iterationId },
      { via: "link", from },
    );
  const editTestCase = () => {
    trackEvalNav("eval_edit_from_test_run", {
      surface: "page",
      project_id: projectId,
    });
    navigateEval({ ...ids, type: "test-run-edit" }, { via: "link", from });
  };
  const jumpToStep = (key: string) => {
    trackEvalNav("eval_edit_from_test_run", {
      surface: "preview_step",
      project_id: projectId,
    });
    navigate(testRunEditPath(ids, key), {
      state: {
        evalNav: {
          via: "link",
          from: {
            path: buildEvaluatePath(route),
            place: evalNavPlace(route, names),
          },
        },
      },
    });
  };
  const togglePreview = () => {
    if (!previewOpen) {
      trackEvalNav("eval_execution_preview_opened", {
        surface: "test_run",
        project_id: projectId,
      });
    }
    setPreviewOpen(!previewOpen);
  };

  let body;
  if (data.status === "runNotFound") {
    body = (
      <p className="text-sm text-muted-foreground">
        This run is not in this suite's history. It may have been deleted, or
        the link is wrong.
      </p>
    );
  } else if (data.status === "loading" || !data.run) {
    body = <TestRunSkeleton />;
  } else if (data.status === "caseNotInRun") {
    body = (
      <p className="text-sm text-muted-foreground">
        This test case did not run in Run #{data.run.runNumber}.
      </p>
    );
  } else {
    body = (
      <TestRunView
        runNumber={data.run.runNumber}
        title={data.title}
        verdict={testRunVerdict(decisions.rows, iterations)}
        passed={resultCounts(iterations).passed}
        total={iterations.length}
        findings={findings}
        scorecard={scorecard}
        targets={targets}
        caseKey={testCaseId}
        selectedTarget={selectedTarget}
        onSelectTarget={onSelectTarget}
        truncated={data.truncated}
        previewToggle={
          previewItems ? { open: previewOpen, onToggle: togglePreview } : null
        }
        preview={
          previewItems && previewOpen ? (
            <ExecutionPreviewPanel
              items={previewItems}
              variant="test_run"
              onJump={jumpToStep}
              onClose={() => setPreviewOpen(false)}
            />
          ) : null
        }
        onOpenIteration={openIteration}
        onCopyFixPrompt={(finding: TestRunFinding) =>
          void copyFixPrompt(testRunFixPrompt(finding, data.title, iterations))
        }
        onEditTestCase={editTestCase}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EvalCrumbBar crumbs={crumbs} back={back} />
      <TestRunScrollArea>{body}</TestRunScrollArea>
      {decisions.readers}
    </div>
  );
}
