import { useState } from "react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { MAX_RUBRIC_CHECK_QUESTIONS } from "@/components/shared/session-quality/judge-config";
import {
  hasCustomJudgesCapability,
  hasRubricChecksCapability,
  hasYesNoRubricQuestionsCapability,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import { areAllChecksValid, ChecksSection } from "../checks-section";
import type { EvalJudgeConfig } from "../types";
import { blankJudge, customJudgeLimits } from "./custom-judges-model";
import { CodeEvaluatorEditor } from "./code-evaluator-editor";
import { JudgeEditor } from "./custom-judges-section";
import { DecisionEditor } from "./decision-questions-section";
import type { MethodAvailability } from "./evaluator-library-browse";
import { EvaluatorLibraryButton } from "./evaluator-library-dialog";
import { draftChanged, EvaluatorEditorLayout } from "./evaluator-editor-layout";
import type { LibraryAddition, LibrarySuiteParts } from "./library-catalog";
import { CUSTOM_JUDGES_OFF_COPY, libraryPauseMessages } from "./library-pause";
import {
  codeMethodAvailability,
  requiredRoleRefusal,
  type SuiteCodeEvaluators,
} from "./suite-code-evaluators";

/** The library entry point in suite settings, with its Method cards. */
export function SuiteEvaluatorLibrary({
  predicates,
  authorableKinds,
  judgeConfig,
  capabilities,
  codeEvaluators,
  onAdd,
}: {
  predicates: LibrarySuiteParts["predicates"];
  authorableKinds: readonly Predicate["type"][];
  judgeConfig: EvalJudgeConfig | undefined;
  capabilities?: SuiteCapabilities | null;
  /** Suite settings only: the Code card is left out without it. */
  codeEvaluators?: SuiteCodeEvaluators;
  /** Saves the addition, or says why it could not. */
  onAdd: (addition: LibraryAddition) => string | undefined;
}) {
  const questions = judgeConfig?.rubricChecks?.questions ?? [];
  const judges = judgeConfig?.customJudges?.judges ?? [];
  const canAskQuestions = hasRubricChecksCapability(capabilities);
  const canAskYesNo =
    canAskQuestions && hasYesNoRubricQuestionsCapability(capabilities);
  const canJudge = hasCustomJudgesCapability(capabilities);
  const { maxJudges, maxPromptLength } = customJudgeLimits(capabilities);
  const pause = libraryPauseMessages(judgeConfig, capabilities);
  const methods: MethodAvailability = {
    assertions: authorableKinds.length
      ? null
      : "This deployment has no assertion types yet. Use a decision question or judge prompt instead.",
    decision: !canAskQuestions
      ? "This deployment does not support decision questions yet. Use an assertion or judge prompt instead."
      : questions.length >= MAX_RUBRIC_CHECK_QUESTIONS
        ? `Remove a question to add another. Each suite can have ${MAX_RUBRIC_CHECK_QUESTIONS} questions.`
        : null,
    judge: !canJudge
      ? "This deployment does not support custom judges yet. Use an assertion or decision question instead."
      : judgeConfig?.customJudges?.enabled === false
        ? CUSTOM_JUDGES_OFF_COPY
        : judges.length >= maxJudges
          ? `Remove a judge to add another. Each suite can have ${maxJudges} judges.`
          : null,
    code: codeEvaluators ? codeMethodAvailability(codeEvaluators) : undefined,
  };
  // Until capabilities load, every method would read as unsupported.
  if (!capabilities) return null;

  return (
    <EvaluatorLibraryButton
      suite={{ predicates, questions, judges }}
      support={{ authorableKinds, canAskYesNo, canJudge }}
      onAdd={onAdd}
      judgeLimit={maxJudges}
      pause={pause}
      authoring={{
        methods,
        render: (method, { close, onDirtyChange }) => {
          const add = (addition: Partial<LibraryAddition>) => {
            const refused = onAdd({
              checks: [],
              questions: [],
              judges: [],
              ...addition,
            });
            if (!refused) close(true);
            return refused;
          };
          const cancel = () => close(false);
          switch (method) {
            case "assertions":
              return (
                <AssertionsEditor
                  kinds={authorableKinds}
                  onCancel={cancel}
                  onSave={(checks) => add({ checks })}
                  onDirtyChange={onDirtyChange}
                />
              );
            case "decision":
              return (
                <DecisionEditor
                  inDialog
                  pauseMessage={pause.questions}
                  canAskYesNo={canAskYesNo}
                  questions={questions}
                  onCancel={cancel}
                  onSave={(question) => add({ questions: [question] })}
                  onDirtyChange={onDirtyChange}
                />
              );
            case "judge":
              return (
                <JudgeEditor
                  inDialog
                  pauseMessage={pause.judges}
                  suiteId={capabilities?.suiteId}
                  judge={blankJudge(judges.map((judge) => judge.id))}
                  variables={capabilities?.judges?.custom?.variables ?? []}
                  maxPromptLength={maxPromptLength}
                  isNew
                  others={judges}
                  onCancel={cancel}
                  onSave={(judge) => add({ judges: [judge] })}
                  onDirtyChange={onDirtyChange}
                />
              );
            case "code":
              return codeEvaluators ? (
                <CodeEvaluatorEditor
                  inDialog
                  others={codeEvaluators.evaluators}
                  scripts={codeEvaluators.scripts}
                  requiredRefusal={requiredRoleRefusal(
                    codeEvaluators.gradingMode,
                  )}
                  test={codeEvaluators.test}
                  onCancel={cancel}
                  onSave={(evaluator) => add({ codeEvaluators: [evaluator] })}
                  onDirtyChange={onDirtyChange}
                />
              ) : null;
          }
        },
      }}
    />
  );
}

function AssertionsEditor({
  kinds,
  onCancel,
  onSave,
  onDirtyChange,
}: {
  kinds: readonly Predicate["type"][];
  onCancel: () => void;
  /** Saves the checks, or says why the suite refused them. */
  onSave: (checks: Predicate[]) => string | undefined;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [checks, setChecksState] = useState<Predicate[]>([]);
  const setChecks = (next: Predicate[]) => {
    setChecksState(next);
    onDirtyChange(draftChanged(next, []));
  };
  const [invalidDraft, setInvalidDraft] = useState(false);
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  return (
    <EvaluatorEditorLayout
      inDialog
      action="Add assertions"
      disabled={!checks.length || invalidDraft}
      error={refusal}
      onCancel={onCancel}
      onSubmit={() => {
        setTried(true);
        if (areAllChecksValid(checks)) setRefusal(onSave(checks));
      }}
    >
      <ChecksSection
        value={checks}
        onChange={setChecks}
        title=""
        hideEmptyState
        addPlaceholder={checks.length ? undefined : "Choose an assertion type"}
        allowedKinds={kinds}
        noun="assertion"
        onDraftValidityChange={setInvalidDraft}
        showAllErrors={tried}
      />
    </EvaluatorEditorLayout>
  );
}
