import { buildEvaluatePath } from "@/lib/app-navigation";

/** The :testCaseId segment is the matrix case key: testCaseId whenever the iteration has one. */
export { matrixCaseKey as testRunCaseKey } from "../run-results-matrix-model";

/** Query param the editor reads to open at a preview item's key ("action:<id>" | "check:<id>" | "outcome" | "after-run"). */
export const EVAL_NAV_STEP_PARAM = "step";

/** Logical path of the editor opened from this test run, optionally at a preview key. */
export function testRunEditPath(
  ids: { suiteId: string; runId: string; testCaseId: string },
  stepKey?: string,
): string {
  const path = buildEvaluatePath({ type: "test-run-edit", ...ids });
  return stepKey
    ? `${path}?${EVAL_NAV_STEP_PARAM}=${encodeURIComponent(stepKey)}`
    : path;
}
