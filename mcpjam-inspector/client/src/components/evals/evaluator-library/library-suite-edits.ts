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
  hasQuestionIdConflict,
  LIBRARY_EVALUATORS,
  taggedQuestions,
  withEvaluatorUpdated,
  withLibraryChecks,
  withoutEvaluator,
} from "./library-catalog";

/** The evaluator a rubric-check row came from, by its `q:<id>` key. */
export function evaluatorIdForQuestionKey(
  key: string | undefined,
): string | undefined {
  if (!key?.startsWith("q:")) return undefined;
  const id = key.slice(2);
  // Exact ids only: a hand-written question named like a library one, such
  // as `reports-tool-errors-mine`, is not from the library.
  return LIBRARY_EVALUATORS.find((e) =>
    taggedQuestions(e).some((q) => q.id === id),
  )?.id;
}

/**
 * Only adding switches rubric checks on, because that is the author asking
 * for questions to run; removing or updating an evaluator keeps the author's
 * own on/off choice.
 */
function withQuestions(
  judgeConfig: EvalJudgeConfig | undefined,
  edit: (current: RubricCheckQuestion[]) => RubricCheckQuestion[],
  turnOn: boolean,
): EvalJudgeConfig {
  const current = judgeConfig?.rubricChecks?.questions ?? [];
  return withRubricChecks(judgeConfig, {
    ...(turnOn ? { enabled: true } : {}),
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
    turnOn = false,
  ) => onJudgeConfigChange?.(withQuestions(judgeConfig, edit, turnOn));
  return {
    add(
      checks: readonly Predicate[],
      questions: readonly RubricCheckQuestion[],
    ) {
      if (checks.length) {
        scope.onPredicatesChange((previous) => withLibraryChecks(previous, checks));
      }
      if (questions.length) {
        setQuestions(
          (current) => [
            ...current,
            ...questions.filter((q) => !current.some((c) => c.id === q.id)),
          ],
          true,
        );
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
      if (
        !entry ||
        hasQuestionIdConflict(entry, judgeConfig?.rubricChecks?.questions ?? [])
      ) return;
      scope.onPredicatesChange((previous) =>
        withEvaluatorUpdated(previous, evaluatorId),
      );
      const questions = taggedQuestions(entry);
      // A new version with fewer or no questions still clears the old ones,
      // or the group would keep offering Update.
      const hadQuestions = judgeConfig?.rubricChecks?.questions?.some(
        (q) => q.evaluator?.id === evaluatorId,
      );
      if (questions.length || hadQuestions) {
        setQuestions((current) => [
          ...current.filter((q) => q.evaluator?.id !== evaluatorId),
          ...questions,
        ]);
      }
    },
  };
}
