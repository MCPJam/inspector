/**
 * The test case as numbered steps: each prompt, interaction or tool call with
 * the assertions graded after it, then the Expected outcome and the After-run
 * assertions. Grouping and numbering come from `groupCaseSteps`; the editor
 * stores nothing but the flat list.
 */
import { useMemo, useState } from "react";
import { Flag, Plus } from "lucide-react";
import { checkRole } from "@mcpjam/sdk/predicates";
import type { SuiteSettingsTab } from "@/lib/eval-route-types";
import type { RemoteServer } from "@/hooks/useProjects";
import { CheckDraftBoundary } from "@/components/evals/checks-section";
import {
  invokableTools,
  type AvailableTool,
} from "@/components/evals/step-fields";
import type { EvalJudgeConfig } from "@/components/evals/types";
import type { Predicate } from "@/shared/eval-matching";
import {
  isWidgetAssertion,
  type SpineChild,
  type TestStep,
} from "@/shared/steps";
import type { CaseScorecard } from "../case-scorecard/case-scorecard-model";
import { EvalAddDrawer } from "../case-spine/assertion-drawer";
import {
  canRemoveAction,
  deleteActionPlan,
  moveActionBlock,
  removeActionWithChecks,
  type DeleteActionPlan,
} from "../case-spine/case-spine-model";
import { CaseOutcome } from "./case-outcome";
import { RemoveStepDialog } from "./remove-step-dialog";
import { removeStepById } from "../simple-case/simple-case-model";
import { assertionSummary } from "./assertion-summary";
import { CaseAfterRun } from "./case-after-run";
import { ActionCard, AssertionEditor, PromptBox } from "./case-step-body";
import {
  addAnything,
  addAssertionAt,
  nextCasePredicateIndex,
  updateStep,
  type CaseStepsDraft,
  type DraftEdit,
} from "./case-step-edits";
import {
  ADD_SMALL,
  ADD_WIDE,
  CaseStepArriving,
  NonBlockingChip,
  StepMenu,
  StepRail,
  StepRow,
  StepSection,
} from "./case-step-parts";
import {
  afterRunSection,
  groupCaseSteps,
  moveAssertionTo,
  STEP_COPY,
} from "./case-steps-model";

export type { CaseStepsDraft } from "./case-step-edits";

export interface CaseStepsEditorProps {
  draft: CaseStepsDraft;
  onDraftChange: (update: (current: CaseStepsDraft) => CaseStepsDraft) => void;
  card: CaseScorecard;
  suite: {
    name: string;
    judgeConfig?: EvalJudgeConfig;
    defaultPredicates: Predicate[];
    servers: string[];
    defaultMatchOptions?: CaseStepsDraft["matchOptions"];
  };
  availableTools: AvailableTool[];
  projectServers?: RemoteServer[];
  readOnly: boolean;
  /** "action:<id>" | "check:<id>" | "route" | "suite:<i>" | "case:<i>", or null. */
  openKey: string | null;
  onOpenKeyChange: (key: string | null) => void;
  /** Row or section key flashing after a jump. */
  flashKey: string | null;
  /** True while arriving from a test run's preview: the stronger flash. */
  arriving: boolean;
  onOpenSuiteSettings: (tab: SuiteSettingsTab) => void;
  onDraftValidityChange?: (invalid: boolean) => void;
}

/** Every row and section carries data-case-step-anchor={key}. */
export function scrollToCaseStep(key: string): void {
  const reduced =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  document
    .querySelector(`[data-case-step-anchor="${CSS.escape(key)}"]`)
    ?.scrollIntoView?.({
      block: "center",
      behavior: reduced ? "auto" : "smooth",
    });
}

type PendingRemove = DeleteActionPlan & { stepId: string };

export function CaseStepsEditor({
  draft,
  onDraftChange,
  card,
  suite,
  availableTools,
  projectServers,
  readOnly,
  openKey,
  onOpenKeyChange,
  flashKey,
  arriving,
  onOpenSuiteSettings,
  onDraftValidityChange,
}: CaseStepsEditorProps) {
  const groups = useMemo(() => groupCaseSteps(draft.steps), [draft.steps]);
  const section = useMemo(() => afterRunSection(card), [card]);
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(
    null,
  );
  const edit = (change: DraftEdit) => {
    if (!readOnly) onDraftChange(change);
  };
  const setSteps = (update: (steps: TestStep[]) => TestStep[]) =>
    edit((current) => ({ ...current, steps: update(current.steps) }));
  const toggle = (key: string) => onOpenKeyChange(openKey === key ? null : key);
  const viewTool = invokableTools(availableTools)[0]?.name ?? "";
  const lastActionId = groups.steps.at(-1)?.step.id ?? null;
  const openSettings = () => onOpenSuiteSettings("evaluators");

  const renderAssertion = (child: SpineChild, actionId: string | null) => {
    const step = child.step;
    if (step.kind !== "assert") return null;
    const s = assertionSummary(step.assertion, actionId !== null);
    const key = `check:${step.id}`;
    const advisory =
      !isWidgetAssertion(step.assertion) &&
      checkRole(step.assertion) === "advisory";
    return (
      <StepRow
        key={step.id}
        anchor={key}
        open={openKey === key}
        flash={flashKey === key}
        onToggle={() => toggle(key)}
        Icon={s.Icon}
        iconClass="text-success"
        label={s.label}
        value={s.value}
        extra={s.extra}
        missing={s.missing}
        chips={advisory ? <NonBlockingChip /> : null}
        menu={
          readOnly ? null : (
            <StepMenu
              label={s.label}
              items={[
                {
                  label: "Remove",
                  onSelect: () =>
                    setSteps((steps) => removeStepById(steps, step.id)),
                },
              ]}
            />
          )
        }
      >
        <AssertionEditor
          step={step}
          actionId={actionId}
          actions={groups.steps}
          availableTools={availableTools}
          readOnly={readOnly}
          onChange={(next) => edit((current) => updateStep(current, next))}
          onMove={(target) =>
            setSteps((steps) => moveAssertionTo(steps, step.id, target))
          }
        />
      </StepRow>
    );
  };

  const requestRemove = (stepId: string) => {
    const plan = deleteActionPlan(draft.steps, stepId);
    if (!plan.needsConfirm) setSteps((steps) => removeStepById(steps, stepId));
    else setPendingRemove({ ...plan, stepId });
  };

  return (
    <CaseStepArriving.Provider value={arriving}>
      <CheckDraftBoundary onValidityChange={onDraftValidityChange}>
        <div className="space-y-5" data-testid="case-steps-editor">
          {groups.leading.length > 0 ? (
            <StepSection
              marker={<Flag className="size-4" aria-hidden />}
              id="case-steps-leading"
              title="Before the first step"
              subtitle="Graded before anything runs."
            >
              <ul className="space-y-2">
                {groups.leading.map((child) => renderAssertion(child, null))}
              </ul>
            </StepSection>
          ) : null}
          {groups.steps.map((action) => {
            const step = action.step;
            const key = `action:${step.id}`;
            const copy = STEP_COPY[step.kind as keyof typeof STEP_COPY];
            const n = action.ordinal;
            const menuItems = [
              {
                label: "Move up",
                disabled: n === 1,
                onSelect: () =>
                  setSteps((steps) => moveActionBlock(steps, step.id, -1)),
              },
              {
                label: "Move down",
                disabled: n === groups.steps.length,
                onSelect: () =>
                  setSteps((steps) => moveActionBlock(steps, step.id, 1)),
              },
              ...(canRemoveAction(draft.steps, step.id)
                ? [{ label: "Remove", onSelect: () => requestRemove(step.id) }]
                : []),
            ];
            return (
              <StepSection
                key={step.id}
                marker={n}
                id={`case-steps-step-${step.id}`}
                anchor={key}
                flash={flashKey === key}
                title={copy.title}
                subtitle={copy.subtitle}
                headerRight={
                  !readOnly && groups.steps.length > 1 ? (
                    <StepMenu label={`step ${n}`} items={menuItems} />
                  ) : null
                }
              >
                {step.kind === "prompt" ? (
                  <PromptBox
                    step={step}
                    first={n === 1}
                    readOnly={readOnly}
                    onChange={(next) =>
                      edit((current) => updateStep(current, next))
                    }
                  />
                ) : step.kind === "assert" ? null : (
                  <ActionCard
                    step={step}
                    open={openKey === key}
                    onToggle={() => toggle(key)}
                    readOnly={readOnly}
                    availableTools={availableTools}
                    suiteServers={suite.servers}
                    projectServers={projectServers}
                    onChange={(next) =>
                      edit((current) => updateStep(current, next))
                    }
                  />
                )}
                <div
                  className="mt-4 space-y-2"
                  role="group"
                  aria-label={`Assertions after step ${n}`}
                >
                  {action.checks.length > 0 ? (
                    <>
                      <p className="text-xs font-medium text-muted-foreground">
                        Assertions at this point
                      </p>
                      <ul className="space-y-2">
                        {action.checks.map((child) =>
                          renderAssertion(child, step.id),
                        )}
                      </ul>
                    </>
                  ) : null}
                  {readOnly ? null : (
                    <EvalAddDrawer
                      triggerLabel="Add assertion"
                      ariaLabel={`Add assertion after step ${n}`}
                      title="Add an assertion"
                      description={`Graded after step ${n}.`}
                      filter={(entry) =>
                        entry.choice.kind === "widget-check" ||
                        (entry.choice.kind === "check" &&
                          entry.scope === "inline")
                      }
                      className={ADD_SMALL}
                      onSelect={(choice) => {
                        const result = addAssertionAt(
                          step.id,
                          choice,
                          viewTool,
                        );
                        if (!result) return;
                        edit(result.edit);
                        onOpenKeyChange(result.openKey);
                      }}
                    />
                  )}
                </div>
              </StepSection>
            );
          })}
          {readOnly ? null : (
            <StepRail
              marker={
                <Plus className="size-4 text-muted-foreground" aria-hidden />
              }
              dashed
            >
              <EvalAddDrawer
                triggerLabel="Add actions or assertions"
                allowRouteChecks
                className={ADD_WIDE}
                onSelect={(choice) => {
                  const result = addAnything(choice, {
                    lastActionId,
                    suiteServers: suite.servers,
                    viewTool,
                    suiteDefaultMatchOptions: suite.defaultMatchOptions,
                    nextCaseIndex: nextCasePredicateIndex(draft),
                  });
                  if (!result) return;
                  edit(result.edit);
                  onOpenKeyChange(result.openKey);
                }}
              />
            </StepRail>
          )}
          <CaseOutcome
            ordinal={groups.outcomeOrdinal}
            draft={draft}
            card={card}
            readOnly={readOnly}
            flash={flashKey === "outcome"}
            onEdit={edit}
            onOpenSuiteSettings={openSettings}
          />
          <CaseAfterRun
            ordinal={groups.afterRunOrdinal}
            section={section}
            draft={draft}
            suiteName={suite.name}
            suiteDefaultMatchOptions={suite.defaultMatchOptions}
            availableTools={availableTools}
            readOnly={readOnly}
            openKey={openKey}
            flashKey={flashKey}
            onToggle={toggle}
            onOpen={onOpenKeyChange}
            onEdit={edit}
            onOpenSuiteSettings={openSettings}
          />
        </div>
      </CheckDraftBoundary>
      <RemoveStepDialog
        pending={pendingRemove}
        onClose={() => setPendingRemove(null)}
        onRemove={(withAssertions) => {
          const stepId = pendingRemove?.stepId;
          if (!stepId) return;
          setSteps((steps) =>
            withAssertions
              ? removeActionWithChecks(steps, stepId)
              : removeStepById(steps, stepId),
          );
          setPendingRemove(null);
        }}
      />
    </CaseStepArriving.Provider>
  );
}
