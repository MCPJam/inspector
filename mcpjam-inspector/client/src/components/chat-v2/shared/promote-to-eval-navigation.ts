import { buildEvalsPath, navigateApp } from "@/lib/app-navigation";

/**
 * What a promote call hands back. Both promote actions
 * (`testSuites:importChatSessionToTestCase` for whole sessions,
 * `testSuites:saveAsTestCaseFromChatMessage` for a single turn) already
 * return `{ suiteId, testCaseId }`, so nothing here needs a backend change.
 * Typed loosely because the callers hold untyped Convex action results.
 */
export type PromotedTestCaseTarget = {
  suiteId?: string | null;
  testCaseId?: string | null;
};

/**
 * Land the promoter on the case they just created — the one behavior every
 * promote-to-eval surface owes the user, and the reason this lives here
 * rather than in each surface: the affordance was consolidated across
 * surfaces, and its follow-through has to be too.
 *
 * Targets the test EDITOR (`test-edit`), not the suite list or overview: the
 * case is the artifact just created, and the editor is where it can be
 * reviewed and adjusted.
 *
 * Returns whether it navigated, so a caller whose ids didn't resolve (an
 * older backend, a shape change) can fall back to its toast instead of
 * navigating somewhere arbitrary.
 */
export function navigateToPromotedTestCase(
  target: PromotedTestCaseTarget,
): boolean {
  const suiteId = target.suiteId?.trim();
  const testId = target.testCaseId?.trim();
  if (!suiteId || !testId) {
    return false;
  }
  navigateApp(buildEvalsPath({ type: "test-edit", suiteId, testId }));
  return true;
}
