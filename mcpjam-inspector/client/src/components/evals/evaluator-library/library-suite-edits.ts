import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  MAX_RUBRIC_CHECK_QUESTIONS,
  type RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import { withRubricChecks } from "../rubric-checks-model";
import type { ScorerTableScope } from "../suite-scorer-table";
import type { EvalJudgeConfig } from "../types";
import {
  findLibraryEvaluator,
  LIBRARY_EVALUATORS,
  taggedChecks,
  taggedQuestions,
  withoutEvaluator,
} from "./library-catalog";

/** The evaluator a rubric-check row came from, by its `q:<id>` key. */
export function evaluatorIdForQuestionKey(
  key: string | undefined,
): string | undefined {
  if (!key?.startsWith("q:")) return undefined;
  const id = key.slice(2);
  return LIBRARY_EVALUATORS.find((e) => id.startsWith(`${e.id}-`))?.id;
}

function withQuestions(
  judgeConfig: EvalJudgeConfig | undefined,
  edit: (current: RubricCheckQuestion[]) => RubricCheckQuestion[],
): EvalJudgeConfig {
  const current = judgeConfig?.rubricChecks?.questions ?? [];
  return withRubricChecks(judgeConfig, {
    enabled: true,
    questions: edit(current).slice(0, MAX_RUBRIC_CHECK_QUESTIONS),
  });
}

/**
 * Whole-evaluator edits for suite settings: checks go to the suite's
 * predicates, questions to its rubric checks. Undefined where the rows on
 * screen are inherited and cannot be edited here.
 */
export function librarySuiteEdits(
  scope: ScorerTableScope,
  judgeConfig: EvalJudgeConfig | undefined,
  onJudgeConfigChange:
    ((next: EvalJudgeConfig | undefined) => void) | undefined,
) {
  if (scope.kind !== "suite") return undefined;
  const setQuestions = (
    edit: (current: RubricCheckQuestion[]) => RubricCheckQuestion[],
  ) => onJudgeConfigChange?.(withQuestions(judgeConfig, edit));
  return {
    add(
      checks: readonly Predicate[],
      questions: readonly RubricCheckQuestion[],
    ) {
      if (checks.length) {
        scope.onPredicatesChange((previous) => [...previous, ...checks]);
      }
      if (questions.length) {
        setQuestions((current) => [
          ...current,
          ...questions.filter((q) => !current.some((c) => c.id === q.id)),
        ]);
      }
    },
    remove(evaluatorId: string) {
      scope.onPredicatesChange((previous) =>
        withoutEvaluator(previous, evaluatorId),
      );
      if (
        judgeConfig?.rubricChecks?.questions?.some(
          (q) => q.evaluator?.id === evaluatorId,
        )
      ) {
        setQuestions((current) =>
          current.filter((q) => q.evaluator?.id !== evaluatorId),
        );
      }
    },
    update(evaluatorId: string) {
      const entry = findLibraryEvaluator(evaluatorId);
      if (!entry) return;
      scope.onPredicatesChange((previous) => [
        ...withoutEvaluator(previous, evaluatorId),
        ...taggedChecks(entry),
      ]);
      const questions = taggedQuestions(entry);
      if (questions.length) {
        setQuestions((current) => [
          ...current.filter((q) => q.evaluator?.id !== evaluatorId),
          ...questions,
        ]);
      }
    },
  };
}
