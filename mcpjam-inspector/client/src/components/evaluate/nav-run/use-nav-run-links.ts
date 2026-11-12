/**
 * Where the Suite run page's rows and findings go. Every link carries the run
 * page as `from`, so the page it opens says "Back to Run #N".
 */
import { useMemo } from "react";
import type { EvalRoute } from "@/lib/eval-route-types";
import type { EvalIteration } from "../../evals/types";
import type { EvalNavNames } from "../nav/eval-nav-crumbs";
import { trackEvalNav } from "../nav/eval-nav-analytics";
import { useEvalNavigate } from "../nav/eval-nav-state";
import { matrixCaseKey } from "../run-results-matrix-model";

export interface NavRunLinks {
  /** caseKey is the matrix row key; targetKey is set when one of several models is picked. */
  openTestRun: (caseKey: string, targetKey: string | null) => void;
  /** Also fires eval_edit_from_test_run. */
  editTestCase: (testCaseId: string) => void;
  openIteration: (iteration: EvalIteration) => void;
}

/** The run content's nav layout: its links, and the suite's pass mark for verdicts. */
export type NavRunOptions = NavRunLinks & {
  /** 0–1, or null. */
  passThreshold: number | null;
};

export function useNavRunLinks(
  route: Extract<EvalRoute, { type: "run-detail" }>,
  names: EvalNavNames,
  projectId: string | null,
): NavRunLinks {
  const navigate = useEvalNavigate();
  return useMemo(() => {
    const leaving = { via: "link" as const, from: { route, names } };
    const { suiteId, runId } = route;
    return {
      openTestRun: (testCaseId, target) =>
        navigate(
          {
            type: "test-run",
            suiteId,
            runId,
            testCaseId,
            ...(target ? { target } : {}),
          },
          leaving,
        ),
      editTestCase: (testCaseId) => {
        navigate(
          { type: "test-run-edit", suiteId, runId, testCaseId },
          leaving,
        );
        trackEvalNav("eval_edit_from_test_run", {
          surface: "list",
          project_id: projectId,
        });
      },
      openIteration: (iteration) =>
        navigate(
          {
            type: "iteration",
            suiteId,
            runId: iteration.suiteRunId ?? runId,
            testCaseId: matrixCaseKey(iteration),
            iterationId: iteration._id,
          },
          leaving,
        ),
    };
  }, [navigate, route, names, projectId]);
}
