/** Grading is dispatched by the backend from the frozen run policy.
 * Retained as a no-op while callers migrate; mounting a run must never spend.
 */
export function LaunchedCaseJudge(_props: { runId: string }) {
  return null;
}
