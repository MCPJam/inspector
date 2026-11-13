import { buildEvaluatePath } from "@/lib/app-navigation";
import type { RunResultPageRoute } from "@/lib/eval-route-types";
import type { EvalIteration } from "../../evals/types";
import { matrixCaseKey } from "../run-results-matrix-model";
import type { RunRef } from "./result-page-links";

/**
 * The URL a result link should be replaced with, or null to stay. With the
 * pages off, a page link falls back to the legacy `?case=&iteration=` form.
 * With them on, that legacy form (still built by GitHub checks and PR
 * comments) moves to the page; `?iteration=` alone waits for the iterations
 * to name its case.
 */
export function resultLinkRewrite({
  enabled,
  run,
  resultPage,
  fromOldLink,
  loading,
  iterations,
}: {
  enabled: boolean | undefined;
  run: RunRef;
  resultPage: RunResultPageRoute;
  fromOldLink: boolean;
  loading: boolean;
  iterations: readonly EvalIteration[];
}): string | null {
  const { caseKey, iterationId } = resultPage;
  if (enabled === false && !fromOldLink) {
    if (loading) return null;
    // The legacy view opens only a saved test case id; a snapshot or title
    // key would leave it blank, so such a link opens the run instead.
    const owner = iterations.find((item) =>
      iterationId ? item._id === iterationId : matrixCaseKey(item) === caseKey,
    );
    return buildEvaluatePath({
      type: "run-detail",
      ...run,
      // The legacy view selects within one run, so open the one that owns it.
      ...(owner?.suiteRunId ? { runId: owner.suiteRunId } : {}),
      ...(owner?.testCaseId ? { testCaseId: owner.testCaseId } : {}),
      ...(iterationId ? { iteration: iterationId } : {}),
    });
  }
  if (enabled !== true || !fromOldLink || loading) return null;
  const hit = iterationId
    ? iterations.find((item) => item._id === iterationId)
    : undefined;
  const key = hit ? matrixCaseKey(hit) : caseKey;
  if (!key) return null;
  return buildEvaluatePath({
    type: "run-detail",
    ...run,
    resultPage: { caseKey: key, ...(iterationId ? { iterationId } : {}) },
  });
}
