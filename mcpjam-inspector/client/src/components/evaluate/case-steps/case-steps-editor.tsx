/**
 * The steps editor: numbered steps, each action with the assertions that
 * grade it nested underneath, then Expected outcome, then After-run
 * assertions. The case is still one flat `steps` list; this only groups it
 * on screen (`groupEditorSteps`), and every edit writes the flat list back.
 */

import { useMemo, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { actionRows, type AssertStep, type TestStep } from "@/shared/steps";
import type { RemoteServer } from "@/hooks/useProjects";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { AvailableTool } from "@/components/evals/step-fields";
import type { EvalAddChoice } from "@/components/evals/eval-add-catalog";
import { authorablePredicateKinds } from "@/components/evals/suite-scorer-table-model";
import { ActionRow } from "../case-spine/action-row";
import { SpineCheckRow } from "../case-spine/spine-check-row";
import { SpineDragProvider } from "../case-spine/spine-drag";
import { EvalAddDrawer } from "../case-spine/assertion-drawer";
import { DeleteActionPrompt } from "../case-spine/case-spine";
import {
  canRemoveAction,
  deleteActionPlan,
  moveActionBlock,
  removeActionWithChecks,
  reorderSpineSteps,
  type DeleteActionPlan,
} from "../case-spine/case-spine-model";
import { removeStepById } from "../simple-case/simple-case-model";
import type { CaseScorecard } from "../case-scorecard/case-scorecard-model";
import {
  groupEditorSteps,
  type EditorAnchor,
  type PreviewEndOfRun,
} from "./case-steps-model";
import type { CaseStepsDraft } from "./case-steps-draft";
import { applyAddChoice } from "./editor-add";
import { ANCHOR_ATTRIBUTE, stepAssertionRows } from "./editor-rows";
import { StepFrame } from "./step-frame";
import { CollapsedAssertion } from "./collapsed-assertion";
import { OutcomeStepBody } from "./editor-outcome-step";
import { AfterRunStepBody } from "./editor-after-run-step";

const STEP_HINTS: Partial<Record<TestStep["kind"], string>> = {
  prompt: "The agent runs and chooses tools.",
  interact: "MCPJam acts in the view, with no model.",
  toolCall: "MCPJam calls the tool, with no model.",
};

export type CaseStepsEditorProps = {
  draft: CaseStepsDraft;
  onChange: (patch: Partial<CaseStepsDraft>) => void;
  card: CaseScorecard;
  endOfRun: PreviewEndOfRun;
  suiteServers: string[];
  projectServers?: RemoteServer[];
  availableTools: AvailableTool[];
  capabilities?: SuiteCapabilities | null;
  readOnly: boolean;
  activeAnchor?: EditorAnchor | null;
  onOpenSuiteSettings: () => void;
};

export function CaseStepsEditor({
  draft,
  onChange,
  card,
  endOfRun,
  suiteServers,
  projectServers,
  availableTools,
  capabilities,
  readOnly,
  activeAnchor,
  onOpenSuiteSettings,
}: CaseStepsEditorProps) {
  const { steps, predicates } = draft;
  const grouped = useMemo(() => groupEditorSteps(steps), [steps]);
  const actions = useMemo(
    () => new Map(actionRows(steps).actions.map((a) => [a.step.id, a])),
    [steps],
  );
  const rows = useMemo(() => stepAssertionRows(card, steps), [card, steps]);
  const [addedId, setAddedId] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLTextAreaElement>(null);
  const checkPolicy = capabilities?.scorers?.checkPolicy === true;
  const authorableKinds = authorablePredicateKinds(
    capabilities?.scorers?.predicateKinds,
  );
  const setSteps = (next: TestStep[]) => {
    if (!readOnly) onChange({ steps: next });
  };
  // A step with assertions asks first, as the old editor does: they can
  // move to the step before or go with it.
  const [pendingRemove, setPendingRemove] = useState<
    (DeleteActionPlan & { stepId: string }) | null
  >(null);
  const removeAction = (stepId: string) => {
    const plan = deleteActionPlan(steps, stepId);
    if (plan.needsConfirm) setPendingRemove({ ...plan, stepId });
    else setSteps(removeActionWithChecks(steps, stepId));
  };
  const settleRemove = (next: TestStep[]) => {
    setSteps(next);
    setPendingRemove(null);
  };

  const add = (choice: EvalAddChoice, actionId: string | null) => {
    if (readOnly) return;
    const result = applyAddChoice({
      choice,
      steps,
      predicates,
      actionId,
      suiteServers,
    });
    if (result.kind === "steps") {
      setAddedId(result.addedId);
      onChange({ steps: result.steps });
    } else if (result.kind === "predicates") {
      onChange({ predicates: result.predicates });
    } else if (result.kind === "outcome") {
      outcomeRef.current?.focus();
    }
  };

  const renderAssertion = (step: AssertStep) => (
    <div
      key={step.id}
      {...{ [ANCHOR_ATTRIBUTE]: `assertion:${step.id}` }}
      tabIndex={-1}
      className={
        activeAnchor === `assertion:${step.id}`
          ? "rounded-md outline-none ring-2 ring-ring"
          : "outline-none"
      }
    >
      <CollapsedAssertion
        step={step}
        defaultOpen={
          addedId === step.id || activeAnchor === `assertion:${step.id}`
        }
      >
        <ul>
          <SpineCheckRow
            step={step}
            row={rows.get(step.id)}
            availableTools={availableTools}
            readOnly={readOnly}
            checkPolicy={checkPolicy}
            status={undefined}
            newest={addedId === step.id}
            defaultOpen
            onChange={(next) =>
              setSteps(steps.map((item) => (item.id === next.id ? next : item)))
            }
            onRemove={() => setSteps(removeStepById(steps, step.id))}
          />
        </ul>
      </CollapsedAssertion>
    </div>
  );

  const reorder = ({ active, over }: DragEndEvent) => {
    if (readOnly || !over || active.id === over.id) return;
    const next = reorderSpineSteps(
      steps,
      String(active.id).slice(5),
      String(over.id).slice(5),
    );
    if (next !== steps) setSteps(next);
  };

  return (
    <SpineDragProvider
      disabled={readOnly}
      items={steps.map((step) => `step:${step.id}`)}
      onReorder={reorder}
    >
      <ol className="space-y-6" data-testid="case-steps-editor">
        {grouped.leading.length > 0 ? (
          <StepFrame number={null} title="Before the first step">
            <div className="space-y-2">
              {grouped.leading.map(renderAssertion)}
            </div>
          </StepFrame>
        ) : null}
        {grouped.steps.map((item) => {
          if (item.kind === "outcome") {
            return (
              <StepFrame
                key={item.anchor}
                number={item.number}
                anchor={item.anchor}
                title={item.title}
                hint="One goal for the whole case. The judge grades it after the run."
                active={activeAnchor === item.anchor}
              >
                <OutcomeStepBody
                  ref={outcomeRef}
                  value={draft.expectedOutput}
                  onChange={(expectedOutput) => onChange({ expectedOutput })}
                  card={card}
                  judgeConfigOverride={draft.judgeConfigOverride}
                  onJudgeConfigOverrideChange={(judgeConfigOverride) =>
                    onChange({ judgeConfigOverride })
                  }
                  readOnly={readOnly}
                />
              </StepFrame>
            );
          }
          if (item.kind === "afterRun") {
            return (
              <StepFrame
                key={item.anchor}
                number={item.number}
                anchor={item.anchor}
                title={item.title}
                hint="Graded once, over the finished run."
                active={activeAnchor === item.anchor}
              >
                <AfterRunStepBody
                  endOfRun={endOfRun}
                  predicates={predicates}
                  onPredicatesChange={(next) => onChange({ predicates: next })}
                  availableTools={availableTools}
                  authorableKinds={authorableKinds}
                  checkPolicy={checkPolicy}
                  readOnly={readOnly}
                  onAdd={(choice) => add(choice, null)}
                  onOpenSuiteSettings={onOpenSuiteSettings}
                />
              </StepFrame>
            );
          }
          const action = actions.get(item.step.id);
          if (!action) return null;
          const isLastAction = item.number === actions.size;
          return [
            <StepFrame
              key={item.anchor}
              number={item.number}
              anchor={item.anchor}
              active={activeAnchor === item.anchor}
            >
              <ul>
                <ActionRow
                  action={action}
                  total={actions.size}
                  status={undefined}
                  isActive={false}
                  readOnly={readOnly}
                  availableTools={availableTools}
                  suiteServers={suiteServers}
                  projectServers={projectServers}
                  newest={addedId === item.step.id}
                  autoFocus={addedId === item.step.id}
                  promptAriaLabel={`${item.title}, step ${item.number}`}
                  onUpdate={(next) =>
                    setSteps(
                      steps.map((step) => (step.id === next.id ? next : step)),
                    )
                  }
                  onMove={(dir) =>
                    setSteps(moveActionBlock(steps, item.step.id, dir))
                  }
                  canRemove={canRemoveAction(steps, item.step.id)}
                  onRemove={() => removeAction(item.step.id)}
                >
                  <div className="space-y-2 pt-1">
                    {STEP_HINTS[item.kind] && item.kind !== "prompt" ? (
                      <p className="text-sm text-muted-foreground">
                        {STEP_HINTS[item.kind]}
                      </p>
                    ) : null}
                    {item.assertions.length > 0 ? (
                      <p className="text-xs font-medium text-muted-foreground">
                        Assertions at this point
                      </p>
                    ) : null}
                    {item.assertions.map(renderAssertion)}
                    {readOnly ? null : (
                      <EvalAddDrawer
                        triggerLabel="Add assertion"
                        authorableKinds={authorableKinds}
                        onOutcomeFocus={() => outcomeRef.current?.focus()}
                        onSelect={(choice) => add(choice, item.step.id)}
                      />
                    )}
                  </div>
                </ActionRow>
              </ul>
            </StepFrame>,
            isLastAction && !readOnly ? (
              <StepFrame key={`${item.anchor}:add`} number={null}>
                <EvalAddDrawer
                  className="h-12 w-full"
                  triggerLabel="Add actions or assertions"
                  authorableKinds={authorableKinds}
                  onOutcomeFocus={() => outcomeRef.current?.focus()}
                  onSelect={(choice) => add(choice, item.step.id)}
                />
              </StepFrame>
            ) : null,
          ];
        })}
      </ol>
      {pendingRemove ? (
        <DeleteActionPrompt
          plan={pendingRemove}
          onCancel={() => setPendingRemove(null)}
          onRemoveOnly={() =>
            settleRemove(removeStepById(steps, pendingRemove.stepId))
          }
          onRemoveWithChecks={() =>
            settleRemove(removeActionWithChecks(steps, pendingRemove.stepId))
          }
        />
      ) : null}
    </SpineDragProvider>
  );
}
