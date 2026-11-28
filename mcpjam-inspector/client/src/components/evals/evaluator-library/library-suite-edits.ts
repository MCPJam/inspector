import type { Predicate } from "@mcpjam/sdk/predicates";
import type {
  CustomJudge,
  RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import { withRubricChecks } from "../rubric-checks-model";
import type { ScorerTableScope } from "../suite-scorer-table";
import type { EvalJudgeConfig } from "../types";
import {
  findLibraryEvaluator,
  judgesWithAdded,
  judgesWithEvaluatorUpdated,
  questionsWithAdded,
  questionsWithEvaluatorUpdated,
  withEvaluatorUpdated,
  withLibraryChecks,
  withoutEvaluator,
  type LibraryAddition,
  type LibraryEvaluator,
} from "./library-catalog";
import type { LibraryModelRow } from "./evaluator-stage-rows";
import { customizedCopy, withJudges } from "./custom-judges-model";
import { codeEvaluatorsWithAdded } from "./code-evaluator-model";
import type { SuiteCodeEvaluators } from "./suite-code-evaluators";

/**
 * The judge config with these rubric-check questions. The author's on/off
 * switch is kept: adding to a suite that turned rubric checks off leaves them
 * off, and the settings say the questions will not run.
 *
 * An emptied slot is kept as `rubricChecks: {}` while other judge config
 * remains: the backend copies any reserved slot a write leaves out from the
 * stored config, so dropping the key would bring the removed questions back.
 * Only a config with nothing else left becomes undefined, which the settings
 * save sends as null to clear it.
 */
function withQuestions(
  judgeConfig: EvalJudgeConfig | undefined,
  questions: RubricCheckQuestion[],
): EvalJudgeConfig | undefined {
  const next = withRubricChecks(judgeConfig, { questions });
  const { rubricChecks, ...rest } = next;
  const empty = !rubricChecks || Object.keys(rubricChecks).length === 0;
  return empty && Object.keys(rest).length === 0 ? undefined : next;
}

/** The two lists one library edit writes. Absent means unchanged. */
type ListsEdit = {
  questions?: RubricCheckQuestion[];
  judges?: CustomJudge[];
};

/** An evaluator's lists at its current version, or why they cannot be. */
type UpdatedLists =
  | { refused: string }
  | {
      refused?: undefined;
      entry: LibraryEvaluator;
      questions: RubricCheckQuestion[];
      judges: CustomJudge[];
    };

/**
 * One judge-config change for both lists. Questions and judges live in the
 * same config, so two separate writes in one click would each start from the
 * same stale config and the second would undo the first.
 */
function withLibraryLists(
  judgeConfig: EvalJudgeConfig | undefined,
  edit: ListsEdit,
): EvalJudgeConfig | undefined {
  let next = judgeConfig;
  if (edit.questions) next = withQuestions(next, edit.questions);
  if (edit.judges) next = withJudges(next, edit.judges);
  return next;
}

/**
 * Whole-evaluator edits for suite settings: checks go to the suite's
 * predicates, questions to its rubric checks and judges to its custom judges.
 * Undefined where the rows on screen are inherited, or the judge config is
 * not editable here. `add` and `update` return why they could not apply and
 * then change nothing, and `updateRefusal` gives that reason up front so the
 * group can show it instead of Update. `judgeLimit` is the backend's
 * `judges.custom.maxJudges`. Code evaluators from the Code card go to `code`.
 */
export function librarySuiteEdits(
  scope: ScorerTableScope,
  judgeConfig: EvalJudgeConfig | undefined,
  onJudgeConfigChange:
    ((next: EvalJudgeConfig | undefined) => void) | undefined,
  judgeLimit: number,
  code?: Pick<SuiteCodeEvaluators, "evaluators" | "onChange">,
) {
  if (scope.kind !== "suite" || !onJudgeConfigChange) return undefined;
  const questions = judgeConfig?.rubricChecks?.questions ?? [];
  const judges = judgeConfig?.customJudges?.judges ?? [];
  const fromEvaluator = (evaluatorId: string) =>
    (item: { evaluator?: { id: string } }) => item.evaluator?.id === evaluatorId;
  const updated = (evaluatorId: string): UpdatedLists => {
    const entry = findLibraryEvaluator(evaluatorId);
    if (!entry) {
      return {
        refused:
          "This Inspector's library has no such evaluator. Remove it, or update it from a newer Inspector.",
      };
    }
    const questionEdit = questionsWithEvaluatorUpdated(entry, questions);
    if (questionEdit.refused !== undefined) return questionEdit;
    const judgeEdit = judgesWithEvaluatorUpdated(entry, judges, judgeLimit);
    if (judgeEdit.refused !== undefined) return judgeEdit;
    return { entry, questions: questionEdit.questions, judges: judgeEdit.judges };
  };
  const write = (edit: ListsEdit) => {
    if (edit.questions || edit.judges) {
      onJudgeConfigChange(withLibraryLists(judgeConfig, edit));
    }
  };
  return {
    add(addition: LibraryAddition): string | undefined {
      const questionEdit = questionsWithAdded(questions, addition.questions);
      if (questionEdit.refused !== undefined) return questionEdit.refused;
      const judgeEdit = judgesWithAdded(judges, addition.judges, judgeLimit);
      if (judgeEdit.refused !== undefined) return judgeEdit.refused;
      const adding = addition.codeEvaluators ?? [];
      if (adding.length && !code) {
        return "Add code evaluators in suite settings.";
      }
      const codeEdit = codeEvaluatorsWithAdded(code?.evaluators ?? [], adding);
      if (codeEdit.refused !== undefined) return codeEdit.refused;
      if (adding.length) code?.onChange(codeEdit.evaluators);
      if (addition.checks.length) {
        // A preset's checks reuse a matching assertion; ones written from
        // scratch are appended as "Add assertion" would, role and all.
        const fromPreset = addition.checks.filter((check) => check.evaluator);
        const written = addition.checks.filter((check) => !check.evaluator);
        scope.onPredicatesChange((previous: Predicate[]) => [
          ...withLibraryChecks(previous, fromPreset),
          ...written,
        ]);
      }
      write({
        ...(addition.questions.length
          ? { questions: questionEdit.questions }
          : {}),
        ...(addition.judges.length ? { judges: judgeEdit.judges } : {}),
      });
      return undefined;
    },
    remove(evaluatorId: string) {
      scope.onPredicatesChange((previous) =>
        withoutEvaluator(previous, evaluatorId),
      );
      const from = fromEvaluator(evaluatorId);
      write({
        ...(questions.some(from)
          ? { questions: questions.filter((q) => !from(q)) }
          : {}),
        ...(judges.some(from) ? { judges: judges.filter((j) => !from(j)) } : {}),
      });
    },
    update(evaluatorId: string): string | undefined {
      const edit = updated(evaluatorId);
      if (edit.refused !== undefined) return edit.refused;
      scope.onPredicatesChange((previous) =>
        withEvaluatorUpdated(previous, evaluatorId),
      );
      // A new version with fewer or no questions or judges still clears the
      // old ones, or the group would keep offering Update.
      const from = fromEvaluator(evaluatorId);
      write({
        ...(edit.entry.questions?.length || questions.some(from)
          ? { questions: edit.questions }
          : {}),
        ...(edit.entry.judges?.length || judges.some(from)
          ? { judges: edit.judges }
          : {}),
      });
      return undefined;
    },
    updateRefusal(evaluatorId: string): string | undefined {
      return updated(evaluatorId).refused;
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
