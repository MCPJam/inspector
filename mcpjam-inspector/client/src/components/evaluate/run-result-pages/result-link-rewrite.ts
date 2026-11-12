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
    return buildEvaluatePath({
      type: "run-detail",
      ...run,
      // A title key names no test case the legacy view can open.
      ...(caseKey.startsWith("title:") ? {} : { testCaseId: caseKey }),
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
