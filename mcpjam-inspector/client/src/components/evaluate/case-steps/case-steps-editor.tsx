/**
 * The steps editor (C8): numbered steps with their assertions nested under
 * them, assertions stored before step 1 above it, then the expected outcome
 * and the after-run assertions (DD1).
 *
 * Storage does not change (E6). Every edit writes the same flat `steps` list,
 * case `predicates` and `expectedOutput` the old editor wrote; the grouping is
 * `groupCaseSteps`, and the rows are the case spine's.
 */

import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import type { TestStep, SpineAction } from "@/shared/steps";
import type { RemoteServer } from "@/hooks/useProjects";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type {
  EvalJudgeConfig,
  EvalJudgeConfigOverride,
} from "@/components/evals/types";
import type { AvailableTool } from "@/components/evals/step-fields";
import { authorablePredicateKinds } from "@/components/evals/suite-scorer-table-model";
import { CheckDraftBoundary } from "@/components/evals/checks-section";
import { EvalAddDrawer } from "../case-spine/assertion-drawer";
import { ActionRow } from "../case-spine/action-row";
import { DeleteActionPrompt } from "../case-spine/case-spine";
import { SpineDragProvider } from "../case-spine/spine-drag";
import {
  canRemoveAction,
  deleteActionPlan,
  moveActionBlock,
  removeActionWithChecks,
  type DeleteActionPlan,
} from "../case-spine/case-spine-model";
import {
  buildCaseScorecard,
  withCaseJudgeSkipped,
} from "../case-scorecard/case-scorecard-model";
import type { ToolCatalogStatus } from "../case-scorecard/route-row";
import {
  initialToolsChoice,
  readSimpleCase,
  removeStepById,
} from "../simple-case/simple-case-model";
import { groupCaseSteps, type EditorStep } from "./case-steps-model";
import {
  addAfterRunAssertion,
  applyAddChoice,
  editAfterRunAssertion,
} from "./case-steps-edits";
import { StepAssertions, type StepAssertionsEnv } from "./step-assertions";
import { StepCard, StepRail } from "./step-card";
import { AfterRunAssertions } from "./after-run-assertions";
import { ExpectedOutcomeSection } from "./expected-outcome-section";
import { blankPredicate } from "@/shared/predicate-kinds";

/** The parts of a case the editor writes. */
export type CaseStepsDraft = {
  steps: TestStep[];
  predicates?: CasePredicates;
  expectedOutput?: string;
  judgeConfigOverride?: EvalJudgeConfigOverride;
  isNegativeTest?: boolean;
};

export type CaseStepsEditorProps = {
  draft: CaseStepsDraft;
  onDraftChange: (patch: Partial<CaseStepsDraft>) => void;
  suiteDefaultPredicates?: Predicate[];
  suppressedSuiteStandardCheckIds?: string[];
  suiteJudgeConfig?: EvalJudgeConfig;
  capabilities?: SuiteCapabilities | null;
  availableTools: AvailableTool[];
  toolsStatus?: ToolCatalogStatus;
  onRetryTools?: () => void;
  suiteServers: string[];
  projectServers?: RemoteServer[];
  readOnly?: boolean;
  onDraftValidityChange?: (invalid: boolean) => void;
  onOpenSuiteSettings?: () => void;
  /** Stored index of a step, or of one of its assertions, to open at. */
  focusStepIndex?: number | null;
};

export function CaseStepsEditor({
  draft,
  onDraftChange,
  suiteDefaultPredicates,
  suppressedSuiteStandardCheckIds,
  suiteJudgeConfig,
  capabilities,
  availableTools,
  toolsStatus,
  onRetryTools,
  suiteServers,
  projectServers,
  readOnly = false,
  onDraftValidityChange,
  onOpenSuiteSettings,
  focusStepIndex,
}: CaseStepsEditorProps) {
  const { steps, predicates } = draft;
  const [addedKey, setAddedKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    (DeleteActionPlan & { stepId: string }) | null
  >(null);
  const outcomeRef = useRef<HTMLTextAreaElement>(null);
  const setSteps = (next: TestStep[]) => onDraftChange({ steps: next });
  const grouped = useMemo(() => groupCaseSteps(steps), [steps]);
  const card = useMemo(
    () =>
      buildCaseScorecard({
        steps,
        toolsChoice: initialToolsChoice({
          tools: readSimpleCase(steps).tools,
          isNegativeTest: draft.isNegativeTest,
        }),
        predicates,
        suiteDefaultPredicates,
        suppressedSuiteStandardCheckIds,
        expectedOutput: draft.expectedOutput,
        judgeConfigOverride: draft.judgeConfigOverride,
        suiteJudgeConfig,
        judgePolicy: capabilities?.judges?.goalCompletion.policy,
        numbering: "action",
      }),
    [
      steps,
      predicates,
      draft.isNegativeTest,
      draft.expectedOutput,
      draft.judgeConfigOverride,
      suiteDefaultPredicates,
      suppressedSuiteStandardCheckIds,
      suiteJudgeConfig,
      capabilities?.judges?.goalCompletion.policy,
    ],
  );
  const serverNamesById = useMemo(
    () =>
      new Map(
        (projectServers ?? []).flatMap((server) =>
          server._id && server.name ? [[server._id, server.name] as const] : [],
        ),
      ),
    [projectServers],
  );
  const authorableKinds = authorablePredicateKinds(
    capabilities?.scorers?.predicateKinds,
  );
  const env: StepAssertionsEnv = {
    steps,
    onStepsChange: setSteps,
    card,
    rowByStepId: new Map(
      card.groups
        .flatMap((group) => group.rows)
        .flatMap((row) => (row.stepId ? [[row.stepId, row] as const] : [])),
    ),
    availableTools,
    toolArgSchemas: Object.fromEntries(
      availableTools.map((tool) => [
        tool.name,
        tool.inputSchema?.properties ?? {},
      ]),
    ),
    toolsStatus,
    onRetryTools,
    readOnly,
    checkPolicy: capabilities?.scorers?.checkPolicy === true,
    addedKey,
  };

  const addAt = (
    anchorStepId: string | null,
    choice: Parameters<typeof applyAddChoice>[0]["choice"],
  ) => {
    if (choice.kind === "outcome") {
      outcomeRef.current?.scrollIntoView?.({ block: "center" });
      outcomeRef.current?.focus();
      return;
    }
    const result = applyAddChoice({
      steps,
      predicates,
      anchorStepId,
      choice,
      suiteServers,
    });
    if (!result.addedKey) return;
    setAddedKey(result.addedKey);
    onDraftChange({ steps: result.steps, predicates: result.predicates });
  };
  const addDrawer = (anchorStepId: string | null, label: string) =>
    readOnly ? null : (
      <EvalAddDrawer
        authorableKinds={authorableKinds}
        triggerLabel={label}
        className="h-10 w-full justify-center rounded-lg border border-dashed border-border bg-transparent text-sm font-medium text-secondary-foreground shadow-none"
        onSelect={(choice) => addAt(anchorStepId, choice)}
      />
    );
  const requestRemove = (stepId: string) => {
    if (readOnly || !canRemoveAction(steps, stepId)) return;
    const plan = deleteActionPlan(steps, stepId);
    if (plan.needsConfirm) setPendingDelete({ ...plan, stepId });
    else setSteps(removeStepById(steps, stepId));
  };

  const renderStep = (editorStep: EditorStep) => {
    const action: SpineAction = {
      step: editorStep.step,
      index: editorStep.index,
      ordinal: editorStep.ordinal,
      turnIndex: editorStep.turnIndex,
      checks: editorStep.assertions,
      lastIndex: editorStep.assertions.at(-1)?.index ?? editorStep.index,
    };
    return (
      <StepCard
        key={editorStep.step.id}
        ordinal={editorStep.ordinal}
        label={editorStep.label}
        step={editorStep.step}
        assertionCount={editorStep.assertions.length}
        serverNamesById={serverNamesById}
        focused={
          focusStepIndex === editorStep.index ||
          editorStep.assertions.some(({ index }) => index === focusStepIndex)
        }
      >
        <ul>
          <ActionRow
            action={action}
            total={grouped.steps.length}
            status={undefined}
            isActive={false}
            readOnly={readOnly}
            availableTools={availableTools}
            suiteServers={suiteServers}
            projectServers={projectServers}
            newest={addedKey === `action:${editorStep.step.id}`}
            promptAriaLabel={`Prompt for step ${editorStep.ordinal}`}
            onUpdate={(next) =>
              setSteps(steps.map((step) => (step.id === next.id ? next : step)))
            }
            onMove={(dir) =>
              setSteps(moveActionBlock(steps, editorStep.step.id, dir))
            }
            canRemove={canRemoveAction(steps, editorStep.step.id)}
            onRemove={() => requestRemove(editorStep.step.id)}
          >
            <div className="space-y-2">
              {editorStep.assertions.length > 0 ? (
                <p className="text-xs font-medium text-muted-foreground">
                  Assertions at this point
                </p>
              ) : null}
              <StepAssertions assertions={editorStep.assertions} env={env} />
              {addDrawer(editorStep.step.id, "Add assertion")}
            </div>
          </ActionRow>
        </ul>
      </StepCard>
    );
  };

  const outcomeOrdinal = grouped.steps.length + 1;
  return (
    <SpineDragProvider disabled items={[]} onReorder={() => {}}>
      <CheckDraftBoundary onValidityChange={onDraftValidityChange}>
        <ol className="space-y-0" data-testid="case-steps-editor">
          {grouped.leadingAssertions.length > 0 ? (
            <StepRail
              marker="·"
              label="Before step 1"
              testId="case-steps-leading"
            >
              <section className="space-y-2" aria-label="Before step 1">
                <h3 className="text-sm font-semibold text-card-foreground">
                  Before step 1
                </h3>
                <StepAssertions
                  assertions={grouped.leadingAssertions}
                  env={env}
                />
              </section>
            </StepRail>
          ) : null}
          {grouped.steps.map(renderStep)}
          {readOnly ? null : (
            <StepRail marker={<Plus className="size-4" />} label="Add a step">
              {addDrawer(null, "Add actions or assertions")}
            </StepRail>
          )}
          <ExpectedOutcomeSection
            ref={outcomeRef}
            ordinal={outcomeOrdinal}
            value={draft.expectedOutput ?? ""}
            judgeRow={card.judge}
            readOnly={readOnly}
            onChange={(expectedOutput) => onDraftChange({ expectedOutput })}
            onOpenSuiteSettings={onOpenSuiteSettings}
            onJudgeSkippedChange={(skipped) =>
              onDraftChange({
                judgeConfigOverride: withCaseJudgeSkipped(
                  draft.judgeConfigOverride,
                  skipped,
                ),
              })
            }
          />
          <AfterRunAssertions
            card={card}
            ordinal={outcomeOrdinal + 1}
            availableTools={availableTools.map((tool) => tool.name)}
            readOnly={readOnly}
            checkPolicy={env.checkPolicy}
            authorableKinds={authorableKinds}
            addedKey={addedKey}
            onOpenSuiteSettings={onOpenSuiteSettings}
            onAdd={(kind) => {
              const result = addAfterRunAssertion(
                steps,
                predicates,
                blankPredicate(kind),
              );
              setAddedKey(result.addedKey);
              onDraftChange({ predicates: result.predicates });
            }}
            onChange={(index, next) =>
              onDraftChange({
                predicates: editAfterRunAssertion(predicates, index, next),
              })
            }
          />
        </ol>
        {pendingDelete ? (
          <DeleteActionPrompt
            plan={pendingDelete}
            onCancel={() => setPendingDelete(null)}
            onRemoveOnly={() => {
              setSteps(removeStepById(steps, pendingDelete.stepId));
              setPendingDelete(null);
            }}
            onRemoveWithChecks={() => {
              setSteps(removeActionWithChecks(steps, pendingDelete.stepId));
              setPendingDelete(null);
            }}
          />
        ) : null}
      </CheckDraftBoundary>
    </SpineDragProvider>
  );
}
