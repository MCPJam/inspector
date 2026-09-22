/**
 * Adapter: one run's iterations → the case list an OpenAI submission report is
 * built from (INS-5).
 *
 * A case may run several iterations. The submission speaks about CASES, so the
 * iterations are folded per case and a case counts as passing only when EVERY
 * iteration of it passed. Taking the first iteration, or "any passed", would
 * let a flaky prompt be submitted as evidence of a reliable one — and flakiness
 * is exactly what a reviewer is trying to detect.
 *
 * Everything comes from `testCaseSnapshot`, the frozen per-iteration record,
 * never from the live suite: the report is about what this run executed.
 */
import type { EvalIteration } from "./types";
import type { SubmissionRunCase } from "@/lib/evals/openai-submission-report";

/** Identity for folding iterations of one case together. */
function caseKeyOf(iteration: EvalIteration): string {
  return (
    iteration.testCaseId ??
    iteration.testCaseSnapshot?.caseKey ??
    iteration.testCaseSnapshot?.title ??
    iteration._id
  );
}

export function buildSubmissionCasesFromRun(
  iterations: EvalIteration[]
): SubmissionRunCase[] {
  const byCase = new Map<string, EvalIteration[]>();
  for (const iteration of iterations) {
    if (!iteration.testCaseSnapshot) continue;
    const key = caseKeyOf(iteration);
    const existing = byCase.get(key);
    if (existing) existing.push(iteration);
    else byCase.set(key, [iteration]);
  }

  const cases: SubmissionRunCase[] = [];
  for (const group of byCase.values()) {
    const first = group[0];
    const snapshot = first.testCaseSnapshot!;
    cases.push({
      title: snapshot.title,
      query: snapshot.query,
      isNegativeTest: snapshot.isNegativeTest === true,
      ...(snapshot.scenario ? { scenario: snapshot.scenario } : {}),
      expectedToolCalls: (snapshot.expectedToolCalls ?? []).map(
        (call) => call.toolName
      ),
      actualToolCalls: (first.actualToolCalls ?? []).map(
        (call) => call.toolName
      ),
      // Every iteration, not the first: a case that passed 2 of 3 times is not
      // evidence of a case that passes.
      passed: group.every((iteration) => iteration.result === "passed"),
      ...(snapshot.model ? { model: snapshot.model } : {}),
      ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    });
  }
  return cases;
}
