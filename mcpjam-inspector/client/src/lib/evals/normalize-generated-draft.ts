import equal from "fast-deep-equal";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { deriveQuery, deriveExpectedToolCalls } from "@/shared/steps";
import type { CreateEvalTestCaseInput } from "./generate-and-persist-tests";

/** Keep suite inheritance intact and budget extra checks across the whole case. */
export function normalizeGeneratedDraft(
  input: CreateEvalTestCaseInput,
  suiteDefaults: Predicate[] = [],
): CreateEvalTestCaseInput {
  const expectedOutput = input.expectedOutput?.trim();
  const source = input.steps ?? [];
  if (
    !source.some((step) => step.kind === "prompt" && step.prompt.trim()) ||
    source.some((step) => step.kind === "prompt" && !step.prompt.trim()) ||
    !expectedOutput
  ) {
    throw new Error(
      `Generated case “${input.title}” needs a user prompt and expected outcome. Retry generation.`,
    );
  }
  let remaining = 1;
  const keepAssertion = (assertion: unknown) => {
    if (suiteDefaults.some((predicate) => equal(predicate, assertion)))
      return false;
    if (!remaining) return false;
    remaining--;
    return true;
  };
  const steps = source.filter(
    (step) => step.kind !== "assert" || keepAssertion(step.assertion),
  );
  const list =
    input.predicates?.mode === "inherit"
      ? []
      : (input.predicates?.list ?? []).filter(keepAssertion);
  return {
    ...input,
    steps,
    query: deriveQuery(steps),
    expectedOutput,
    expectedToolCalls: deriveExpectedToolCalls(steps),
    predicates: list.length
      ? { mode: "extend", list }
      : { mode: "inherit", list: [] },
  };
}
