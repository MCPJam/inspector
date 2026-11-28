import { makeFunctionReference } from "convex/server";

/**
 * The iterations "Test on a past iteration" offers, for judges and code
 * evaluators alike: a suite's latest completed iterations from finished
 * runs, newest first. Empty for someone who can't configure the suite.
 */
export type PastIteration = {
  iterationId: string;
  runNumber: number | null;
  title: string;
  result: string | null;
  createdAt: number;
};

export const listPastIterationsRef = makeFunctionReference<
  "query",
  { suiteId: string },
  PastIteration[]
>("customJudgePreviewAuth:listCustomJudgePreviewIterations");

/** One choice in the Past iteration list. */
export function pastIterationLabel(
  iteration: PastIteration,
  index: number,
): string {
  return [
    `Recent iteration ${index + 1}`,
    ...(iteration.runNumber !== null ? [`Run #${iteration.runNumber}`] : []),
    iteration.title,
    ...(iteration.result ? [iteration.result] : []),
    new Date(iteration.createdAt).toLocaleString(),
  ].join(" · ");
}
