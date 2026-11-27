import type { Predicate } from "@mcpjam/sdk/predicates";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import { withRubricChecks } from "../rubric-checks-model";
import type { ScorerTableScope } from "../suite-scorer-table";
import type { EvalJudgeConfig } from "../types";
import {
  findLibraryEvaluator,
  questionsWithAdded,
  questionsWithEvaluatorUpdated,
  withEvaluatorUpdated,
  withLibraryChecks,
  withoutEvaluator,
  type QuestionsEdit,
} from "./library-catalog";

/**
 * The judge config with these rubric-check questions. Adding turns rubric
 * checks back on if the author had turned them off, because adding asks for
 * questions to run; a switch that was never set already means on, so it
 * stays unset. A slot or config this empties is dropped, so adding an
 * evaluator and removing it again leaves the config as it was.
 */
function withQuestions(
  judgeConfig: EvalJudgeConfig | undefined,
  questions: RubricCheckQuestion[],
  turnOn: boolean,
): EvalJudgeConfig | undefined {
  const next = withRubricChecks(judgeConfig, {
    ...(turnOn && judgeConfig?.rubricChecks?.enabled === false
      ? { enabled: true }
      : {}),
    questions,
  });
  if (next.rubricChecks && Object.keys(next.rubricChecks).length > 0) {
    return next;
  }
  const rest = { ...next };
  delete rest.rubricChecks;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Whole-evaluator edits for suite settings: checks go to the suite's
 * predicates, questions to its rubric checks. Undefined where the rows on
 * screen are inherited, or the judge config is not editable here. `add` and
 * `update` return why they could not apply and then change nothing, and
 * `updateRefusal` gives that reason up front so the group can show it
 * instead of Update.
 */
export function librarySuiteEdits(
  scope: ScorerTableScope,
  judgeConfig: EvalJudgeConfig | undefined,
  onJudgeConfigChange:
    ((next: EvalJudgeConfig | undefined) => void) | undefined,
) {
  if (scope.kind !== "suite" || !onJudgeConfigChange) return undefined;
  const questions = judgeConfig?.rubricChecks?.questions ?? [];
  const tagged = (evaluatorId: string) =>
    questions.some((q) => q.evaluator?.id === evaluatorId);
  const updated = (evaluatorId: string): QuestionsEdit => {
    const entry = findLibraryEvaluator(evaluatorId);
    if (!entry) {
      return {
        refused:
          "This Inspector's library has no such evaluator. Remove it, or update it from a newer Inspector.",
      };
    }
    return questionsWithEvaluatorUpdated(entry, questions);
  };
  return {
    add(
      checks: readonly Predicate[],
      adding: readonly RubricCheckQuestion[],
    ): string | undefined {
      const edit = questionsWithAdded(questions, adding);
      if (edit.refused !== undefined) return edit.refused;
      if (checks.length) {
        scope.onPredicatesChange((previous) =>
          withLibraryChecks(previous, checks),
        );
      }
      if (adding.length) {
        onJudgeConfigChange(withQuestions(judgeConfig, edit.questions, true));
      }
      return undefined;
    },
    remove(evaluatorId: string) {
      scope.onPredicatesChange((previous) =>
        withoutEvaluator(previous, evaluatorId),
      );
      if (tagged(evaluatorId)) {
        onJudgeConfigChange(
          withQuestions(
            judgeConfig,
            questions.filter((q) => q.evaluator?.id !== evaluatorId),
            false,
          ),
        );
      }
    },
    update(evaluatorId: string): string | undefined {
      const edit = updated(evaluatorId);
      if (edit.refused !== undefined) return edit.refused;
      scope.onPredicatesChange((previous) =>
        withEvaluatorUpdated(previous, evaluatorId),
      );
      if (
        findLibraryEvaluator(evaluatorId)?.questions?.length ||
        tagged(evaluatorId)
      ) {
        onJudgeConfigChange(withQuestions(judgeConfig, edit.questions, false));
      }
      return undefined;
    },
    updateRefusal(evaluatorId: string): string | undefined {
      return updated(evaluatorId).refused;
    },
  };
}
