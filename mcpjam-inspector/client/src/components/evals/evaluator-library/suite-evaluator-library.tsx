import { useState } from "react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  MAX_CUSTOM_JUDGES,
  MAX_RUBRIC_CHECK_QUESTIONS,
} from "@/components/shared/session-quality/judge-config";
import {
  hasCustomJudgesCapability,
  hasRubricChecksCapability,
  hasYesNoRubricQuestionsCapability,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import { areAllChecksValid, ChecksSection } from "../checks-section";
import { RUBRIC_CHECKS_GOAL_OFF_COPY } from "../rubric-checks-judge-card";
import { judgeMode } from "../suite-grading-model";
import type { EvalJudgeConfig } from "../types";
import { blankJudge } from "./custom-judges-model";
import { JudgeEditor } from "./custom-judges-section";
import { DecisionEditor } from "./decision-questions-section";
import type { MethodAvailability } from "./evaluator-library-browse";
import { EvaluatorLibraryButton } from "./evaluator-library-dialog";
import { EvaluatorEditorLayout } from "./evaluator-editor-layout";
import type { LibraryAddition, LibrarySuiteParts } from "./library-catalog";

export function SuiteEvaluatorLibrary({
  predicates,
  authorableKinds,
  judgeConfig,
  canEditJudgeConfig,
  capabilities,
  onAdd,
}: {
  predicates: LibrarySuiteParts["predicates"];
  authorableKinds: readonly Predicate["type"][];
  judgeConfig: EvalJudgeConfig | undefined;
  canEditJudgeConfig: boolean;
  capabilities?: SuiteCapabilities | null;
  onAdd: (addition: LibraryAddition) => void;
}) {
  const questions = judgeConfig?.rubricChecks?.questions ?? [];
  const judges = judgeConfig?.customJudges?.judges ?? [];
  const canAskQuestions =
    canEditJudgeConfig && hasRubricChecksCapability(capabilities);
  const canAskYesNo =
    canAskQuestions && hasYesNoRubricQuestionsCapability(capabilities);
  const canJudge =
    canEditJudgeConfig && hasCustomJudgesCapability(capabilities);
  const goalJudgeOff =
    judgeMode(judgeConfig, capabilities?.judges?.goalCompletion?.policy) ===
    "off";
  const judgeLimit = Math.min(
    MAX_CUSTOM_JUDGES,
    capabilities?.judges?.custom?.maxJudges ?? MAX_CUSTOM_JUDGES,
  );
  const methods: MethodAvailability = {
    assertions: authorableKinds.length
      ? null
      : "No assertion types are available on this deployment.",
    decision: !canAskQuestions
      ? "This suite does not support decision questions."
      : questions.length >= MAX_RUBRIC_CHECK_QUESTIONS
        ? `Remove a question to add another. Each suite can have ${MAX_RUBRIC_CHECK_QUESTIONS} questions.`
        : null,
    judge: !canJudge
      ? "This suite does not support custom judges."
      : judges.length >= judgeLimit
        ? `Remove a judge to add another. Each suite can have ${judgeLimit} judges.`
        : null,
  };

  return (
    <EvaluatorLibraryButton
      suite={{ predicates, questions, judges }}
      support={{ authorableKinds, canAskYesNo, canJudge }}
      onAdd={onAdd}
      judgeLimit={judgeLimit}
      authoring={{
        methods,
        render: (method, onBack) => {
          const add = (addition: Partial<LibraryAddition>) => {
            onAdd({ checks: [], questions: [], judges: [], ...addition });
            onBack();
          };
          switch (method) {
            case "assertions":
              return (
                <AssertionsEditor
                  kinds={authorableKinds}
                  onCancel={onBack}
                  onSave={(checks) => add({ checks })}
                />
              );
            case "decision":
              return (
                <DecisionEditor
                  inDialog
                  pauseMessage={
                    goalJudgeOff ? RUBRIC_CHECKS_GOAL_OFF_COPY : undefined
                  }
                  canAskYesNo={canAskYesNo}
                  questions={questions}
                  onCancel={onBack}
                  onSave={(question) => add({ questions: [question] })}
                />
              );
            case "judge":
              return (
                <JudgeEditor
                  inDialog
                  pauseMessage={
                    goalJudgeOff
                      ? "Custom judges are paused while the goal-completion judge is off."
                      : undefined
                  }
                  suiteId={capabilities?.suiteId}
                  judge={blankJudge(judges.map((judge) => judge.id))}
                  variables={capabilities?.judges?.custom?.variables ?? []}
                  variableAliases={capabilities?.judges?.custom?.variableAliases}
                  others={judges}
                  onCancel={onBack}
                  onSave={(judge) => add({ judges: [judge] })}
                />
              );
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
}: {
  kinds: readonly Predicate["type"][];
  onCancel: () => void;
  onSave: (checks: Predicate[]) => void;
}) {
  const [checks, setChecks] = useState<Predicate[]>([]);
  const [invalidDraft, setInvalidDraft] = useState(false);
  const [tried, setTried] = useState(false);
  return (
    <EvaluatorEditorLayout
      inDialog
      action="Add assertions"
      disabled={!checks.length || invalidDraft}
      onCancel={onCancel}
      onSubmit={() => {
        setTried(true);
        if (areAllChecksValid(checks)) onSave(checks);
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
