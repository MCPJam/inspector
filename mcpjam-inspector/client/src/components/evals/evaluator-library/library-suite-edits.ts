import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  MAX_CUSTOM_JUDGES,
  MAX_RUBRIC_CHECK_QUESTIONS,
  type CustomJudge,
  type RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import { withRubricChecks } from "../rubric-checks-model";
import type { ScorerTableScope } from "../suite-scorer-table";
import type { EvalJudgeConfig } from "../types";
import {
  findLibraryEvaluator,
  hasLibraryIdConflict,
  LIBRARY_QUESTION_IDS,
  taggedJudges,
  taggedQuestions,
  withEvaluatorUpdated,
  withoutEvaluator,
  type LibraryAddition,
} from "./library-catalog";
import type { LibraryModelRow } from "./evaluator-stage-rows";
import { customizedCopy, withJudges } from "./custom-judges-model";

/** The evaluator a rubric-check row came from, by its `q:<id>` key. */
export function evaluatorIdForQuestionKey(
  key: string | undefined,
): string | undefined {
  if (!key?.startsWith("q:")) return undefined;
  return LIBRARY_QUESTION_IDS.get(key.slice(2));
}

type ListEdit<T> = (current: T[]) => T[];

/**
 * One judge-config change for both lists. Questions and judges live in the
 * same config, so two separate writes in one click would each start from the
 * same stale config and the second would undo the first.
 */
function withLibraryLists(
  judgeConfig: EvalJudgeConfig | undefined,
  edits: {
    questions?: ListEdit<RubricCheckQuestion>;
    enableQuestions?: boolean;
    judges?: ListEdit<CustomJudge>;
  },
): EvalJudgeConfig | undefined {
  let next = judgeConfig;
  if (edits.questions) {
    next = withRubricChecks(next, {
      ...(edits.enableQuestions ? { enabled: true } : {}),
      questions: edits.questions(next?.rubricChecks?.questions ?? []),
    });
  }
  if (edits.judges) {
    next = withJudges(next, edits.judges(next?.customJudges?.judges ?? []));
  }
  return next;
}

const notFrom =
  (evaluatorId: string) =>
  <T extends { evaluator?: { id: string } }>(item: T) =>
    item.evaluator?.id !== evaluatorId;

/** Inherited evaluators are edited at the suite level. */
export function librarySuiteEdits(
  scope: ScorerTableScope,
  judgeConfig: EvalJudgeConfig | undefined,
  onJudgeConfigChange:
    ((next: EvalJudgeConfig | undefined) => void) | undefined,
) {
  if (scope.kind !== "suite") return undefined;
  const currentQuestions = judgeConfig?.rubricChecks?.questions ?? [];
  const currentJudges = judgeConfig?.customJudges?.judges ?? [];
  const editLists = (edits: Parameters<typeof withLibraryLists>[1]) => {
    if (!edits.questions && !edits.judges) return;
    onJudgeConfigChange?.(withLibraryLists(judgeConfig, edits));
  };
  return {
    add({ checks, questions, judges }: LibraryAddition) {
      if (
        (judges.length > 0 && currentJudges.length + judges.length > MAX_CUSTOM_JUDGES) ||
        (questions.length > 0 &&
          currentQuestions.length + questions.length > MAX_RUBRIC_CHECK_QUESTIONS)
      ) {
        return;
      }
      if (checks.length) {
        scope.onPredicatesChange((previous: Predicate[]) => [
          ...previous,
          ...checks,
        ]);
      }
      editLists({
        ...(questions.length
          ? {
              enableQuestions: judgeConfig?.rubricChecks?.enabled !== false,
              questions: (current) => [
                ...current,
                ...questions.filter((q) => !current.some((c) => c.id === q.id)),
              ],
            }
          : {}),
        ...(judges.length
          ? {
              judges: (current) => [
                ...current,
                ...judges.filter((j) => !current.some((c) => c.id === j.id)),
              ],
            }
          : {}),
      });
    },
    remove(evaluatorId: string) {
      scope.onPredicatesChange((previous) =>
        withoutEvaluator(previous, evaluatorId),
      );
      const keep = notFrom(evaluatorId);
      editLists({
        ...(judgeConfig?.rubricChecks?.questions?.some((q) => !keep(q))
          ? { questions: (current) => current.filter(keep) }
          : {}),
        ...(judgeConfig?.customJudges?.judges?.some((j) => !keep(j))
          ? { judges: (current) => current.filter(keep) }
          : {}),
      });
    },
    update(evaluatorId: string) {
      const entry = findLibraryEvaluator(evaluatorId);
      if (
        !entry ||
        hasLibraryIdConflict(entry, {
          questions: currentQuestions,
          judges: currentJudges,
        })
      ) return;
      const keep = notFrom(evaluatorId);
      const questions = taggedQuestions(entry);
      const judges = taggedJudges(entry);
      if (
        currentQuestions.filter(keep).length + questions.length > MAX_RUBRIC_CHECK_QUESTIONS ||
        currentJudges.filter(keep).length + judges.length > MAX_CUSTOM_JUDGES
      ) return;
      scope.onPredicatesChange((previous) =>
        withEvaluatorUpdated(previous, evaluatorId),
      );
      editLists({
        ...(questions.length || currentQuestions.some((q) => !keep(q))
          ? { questions: (current) => [...current.filter(keep), ...questions] }
          : {}),
        ...(judges.length || currentJudges.some((j) => !keep(j))
          ? { judges: (current) => [...current.filter(keep), ...judges] }
          : {}),
      });
    },
  };
}

export function libraryModelRows(
  judgeConfig: EvalJudgeConfig | undefined,
  onJudgeConfigChange?: (next: EvalJudgeConfig | undefined) => void,
): LibraryModelRow[] {
  const judges = judgeConfig?.customJudges?.judges ?? [];
  const rows: LibraryModelRow[] = [];
  for (const q of judgeConfig?.rubricChecks?.questions ?? []) {
    if (!q.evaluator) continue;
    rows.push({
      key: `q:${q.id}`,
      label: q.label,
      detail: `Yes/no question, passes on ${q.pass.answer === "no" ? "No" : "Yes"}`,
      evaluator: q.evaluator,
    });
  }
  for (const j of judges) {
    if (!j.evaluator) continue;
    rows.push({
      key: `judge:${j.id}`,
      label: j.label,
      detail:
        j.output.kind === "score"
          ? `Judge prompt, passes at ${j.output.threshold} or more`
          : "Judge prompt, pass or fail",
      evaluator: j.evaluator,
      ...(onJudgeConfigChange
        ? {
            onCustomize: () => {
              const copy = customizedCopy(
                j,
                judges.map((o) => o.id),
              );
              onJudgeConfigChange(
                withJudges(
                  judgeConfig,
                  judges.map((o) => (o.id === j.id ? copy : o)),
                ),
              );
            },
          }
        : {}),
    });
  }
  return rows;
}
