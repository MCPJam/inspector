/**
 * The case, as one list.
 *
 * Replaces three surfaces that each held part of a case: the form (a prompt, a
 * tool question, a rubric box), the Steps pane behind a one-way "Steps" link
 * (everything the form could not author), and the header gear (match options
 * and the predicate envelope). A check written after a click had no place to
 * appear in any of them, which is why "assert a tool call after a prompt" was
 * not expressible.
 *
 * Two states, one component. A case that is still just a prompt renders the
 * FIRST-RUN FORM: what should the user ask, what should a successful answer
 * accomplish, and Run. Everything else lives behind "More options", because
 * before a single trial exists the author has nothing to harden and no
 * evidence to harden it from. The moment the case carries a check, a route, a
 * click or a second action, the spine renders instead — the author has said
 * something the two fields cannot show.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  actionRows,
  insertStepAfter,
  newStepId,
  stepTurnIndices,
  type AssertStep,
  type TestStep,
} from "@/shared/steps";
import { blankPredicate } from "@/shared/predicate-kinds";
import {
  resolveMatchOptions,
  type CasePredicates,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { RemoteServer } from "@/hooks/useProjects";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type {
  EvalJudgeConfig,
  EvalJudgeConfigOverride,
  EvalJudgeRubric,
} from "@/components/evals/types";
import {
  defaultWidgetAssertion,
  type AvailableTool,
} from "@/components/evals/step-fields";
import { SuiteScorerLibraryMenu } from "@/components/evals/suite-scorer-library-menu";
import { authorablePredicateKinds } from "@/components/evals/suite-scorer-table-model";
import {
  buildCaseScorecard,
  spineLibraryKinds,
  appendCaseScorer,
  removeCaseScorer,
  updateCaseScorer,
  withCaseJudgeSkipped,
} from "../case-scorecard/case-scorecard-model";
import { RouteRow } from "../case-scorecard/route-row";
import {
  initialToolsChoice,
  isPromptFirst,
  matchOptionsForKind,
  readSimpleCase,
  removeStepById,
  updateStepCheck,
  writeSimpleCase,
  type CaseKind,
  type SimpleCaseTool,
  type ToolsChoice,
} from "../simple-case/simple-case-model";
import { ActionRow } from "./action-row";
import { AfterTheRunSection } from "./after-the-run";
import { SpineCheckRow } from "./spine-check-row";
import {
  deleteActionPlan,
  isQuietCase,
  moveActionBlock,
  removeActionWithChecks,
  spineStatus,
  type DeleteActionPlan,
} from "./case-spine-model";

export type CaseSpineProps = {
  steps: TestStep[];
  onStepsChange: (next: TestStep[]) => void;
  matchOptions?: EvalMatchOptions;
  onMatchOptionsChange: (next: EvalMatchOptions) => void;
  suiteDefaultMatchOptions?: EvalMatchOptions;
  kind?: CaseKind;
  onKindChange?: (next: CaseKind) => void;
  expectedOutput?: string;
  onExpectedOutputChange: (next: string) => void;
  predicates?: CasePredicates;
  onPredicatesChange: (next: CasePredicates | undefined) => void;
  suiteDefaultPredicates?: Predicate[];
  snapshotPredicates?: Predicate[];
  availableTools?: AvailableTool[];
  suiteServers?: string[];
  projectServers?: RemoteServer[];
  isNegativeTest?: boolean;
  toolsChoice?: ToolsChoice;
  onToolsChoiceChange?: (next: ToolsChoice) => void;
  stashedTools?: SimpleCaseTool[];
  onStashedToolsChange?: (next: SimpleCaseTool[]) => void;
  judgeConfigOverride?: EvalJudgeConfigOverride;
  onJudgeConfigOverrideChange?: (
    next: EvalJudgeConfigOverride | undefined,
  ) => void;
  suiteJudgeConfig?: EvalJudgeConfig;
  suiteJudgeRubric?: EvalJudgeRubric;
  capabilities?: SuiteCapabilities | null;
  onOpenSuiteSettings?: () => void;
  evalValidationBorderClass?: string;
  autoFocusPrompt?: boolean;
  validationAttempted?: boolean;
  recording?: boolean;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onAddCheck?: () => void;
  recordEntryPrimary?: boolean;
  readOnly?: boolean;
  inspectHeader?: ReactNode;
  stepStatusById?: Map<string, EvalStepStatus>;
  stepStatusByTurn?: Map<number, EvalStepStatus>;
  syncedStepId?: string | null;
  onHoverStep?: (stepId: string | null) => void;
  onSelectStep?: (stepId: string) => void;
  /** The Run control. A slot so the spine never owns launching a run. */
  runControl?: ReactNode;
};

export function CaseSpine({
  steps,
  onStepsChange,
  matchOptions,
  onMatchOptionsChange,
  suiteDefaultMatchOptions,
  kind: persistedKind,
  onKindChange,
  expectedOutput,
  onExpectedOutputChange,
  predicates,
  onPredicatesChange,
  suiteDefaultPredicates,
  snapshotPredicates,
  availableTools = [],
  suiteServers = [],
  projectServers,
  isNegativeTest,
  toolsChoice: controlledToolsChoice,
  onToolsChoiceChange,
  stashedTools: controlledStashedTools,
  onStashedToolsChange,
  judgeConfigOverride,
  onJudgeConfigOverrideChange,
  suiteJudgeConfig,
  suiteJudgeRubric,
  capabilities,
  onOpenSuiteSettings,
  evalValidationBorderClass,
  autoFocusPrompt,
  validationAttempted = false,
  recording = false,
  onStartRecording,
  onStopRecording,
  onAddCheck,
  recordEntryPrimary = false,
  readOnly = false,
  inspectHeader,
  stepStatusById,
  stepStatusByTurn,
  syncedStepId,
  onHoverStep,
  onSelectStep,
  runControl,
}: CaseSpineProps) {
  const view = useMemo(() => readSimpleCase(steps), [steps]);
  const resolvedMatch = resolveMatchOptions(
    suiteDefaultMatchOptions,
    matchOptions,
  );

  const [uncontrolledToolsChoice, setUncontrolledToolsChoice] =
    useState<ToolsChoice>(() =>
      initialToolsChoice({ tools: view.tools, isNegativeTest }),
    );
  const toolsChoice = controlledToolsChoice ?? uncontrolledToolsChoice;
  const setToolsChoice = (next: ToolsChoice) => {
    setUncontrolledToolsChoice(next);
    onToolsChoiceChange?.(next);
  };
  const [uncontrolledStashedTools, setUncontrolledStashedTools] = useState<
    SimpleCaseTool[]
  >(() => view.tools);
  const stashedTools = controlledStashedTools ?? uncontrolledStashedTools;
  const setStashedTools = (next: SimpleCaseTool[]) => {
    setUncontrolledStashedTools(next);
    onStashedToolsChange?.(next);
  };

  useEffect(() => {
    if (view.tools.length > 0 && toolsChoice !== "tools") {
      setToolsChoice("tools");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.tools, toolsChoice]);

  /** A newly added check opens expanded — a blank one has nothing to read. */
  const [addedKey, setAddedKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    (DeleteActionPlan & { stepId: string }) | null
  >(null);
  /** Whether the first-run form has revealed everything else. */
  const [moreOpen, setMoreOpen] = useState(false);

  const card = useMemo(
    () =>
      buildCaseScorecard({
        steps,
        toolsChoice,
        kind: persistedKind,
        matchOptions,
        suiteDefaultMatchOptions,
        predicates,
        suiteDefaultPredicates,
        snapshotPredicates,
        expectedOutput,
        judgeConfigOverride,
        suiteJudgeConfig,
        suiteJudgeRubric,
        numbering: "action",
      }),
    [
      steps,
      toolsChoice,
      persistedKind,
      matchOptions,
      suiteDefaultMatchOptions,
      predicates,
      suiteDefaultPredicates,
      snapshotPredicates,
      expectedOutput,
      judgeConfigOverride,
      suiteJudgeConfig,
      suiteJudgeRubric,
    ],
  );

  const rows = useMemo(() => actionRows(steps), [steps]);
  const turns = useMemo(() => stepTurnIndices(steps), [steps]);
  const rowByStepId = useMemo(
    () =>
      new Map(
        card.groups
          .flatMap((group) => group.rows)
          .filter((row) => row.stepId)
          .map((row) => [row.stepId as string, row]),
      ),
    [card],
  );

  const checkPolicy = capabilities?.scorers?.checkPolicy === true;
  // What this DEPLOYMENT can evaluate, intersected by the menu with what
  // this SURFACE offers. A kind an older backend rejects is a failed save;
  // one an older runner cannot evaluate fails closed on every trial.
  const authorableKinds = authorablePredicateKinds(
    capabilities?.scorers?.predicateKinds,
  );
  const showUnsetError = validationAttempted && card.unsetBlockReason !== null;
  const promptReady = view.prompt.trim().length > 0;
  const quiet = useMemo(
    () => isQuietCase({ steps, predicates, toolsChoice }),
    [steps, predicates, toolsChoice],
  );

  // ── writers ────────────────────────────────────────────────────────────────

  const setKind = (next: CaseKind) => {
    if (readOnly) return;
    onKindChange?.(next);
    onMatchOptionsChange(matchOptionsForKind(next, resolvedMatch));
  };
  const setPrompt = (prompt: string) => {
    if (readOnly) return;
    onStepsChange(
      writeSimpleCase(steps, {
        prompt,
        tools: view.tools,
        noTool: toolsChoice === "noTool",
      }),
    );
  };
  const setTools = (tools: SimpleCaseTool[]) => {
    if (readOnly) return;
    setStashedTools(tools);
    onStepsChange(
      writeSimpleCase(steps, { prompt: view.prompt, tools, noTool: false }),
    );
  };
  const chooseNoTool = () => {
    if (readOnly) return;
    if (view.tools.length > 0) setStashedTools(view.tools);
    setToolsChoice("noTool");
    onStepsChange(
      writeSimpleCase(steps, {
        prompt: view.prompt,
        tools: view.tools,
        noTool: true,
      }),
    );
  };
  const chooseTools = () => {
    if (readOnly) return;
    setToolsChoice("tools");
    const restored = view.tools.length > 0 ? view.tools : stashedTools;
    onStepsChange(
      writeSimpleCase(steps, {
        prompt: view.prompt,
        tools: restored,
        noTool: false,
      }),
    );
  };
  const addTool = (toolName: string) => {
    if (readOnly) return;
    const name = toolName.trim();
    if (!name) return;
    setToolsChoice("tools");
    setTools([
      ...view.tools,
      { id: newStepId("assert"), toolName: name, arguments: {} },
    ]);
  };

  /** Add a check directly after one action's block. */
  const addCheckAfter = (
    anchorStepId: string,
    assertion: AssertStep["assertion"],
  ) => {
    if (readOnly) return;
    const step: AssertStep = {
      id: newStepId("assert"),
      kind: "assert",
      assertion,
    };
    setAddedKey(`step:${step.id}`);
    onStepsChange(insertStepAfter(steps, anchorStepId, step));
  };

  const requestRemoveAction = (stepId: string) => {
    if (readOnly) return;
    const plan = deleteActionPlan(steps, stepId);
    if (!plan.needsConfirm) {
      onStepsChange(removeStepById(steps, stepId));
      return;
    }
    setPendingDelete({ ...plan, stepId });
  };

  // ── first-run form ─────────────────────────────────────────────────────────

  if (quiet && !readOnly && !moreOpen) {
    const promptStep = rows.actions[0]?.step;
    return (
      <div
        className="space-y-6"
        data-testid="case-spine"
        data-state="first-run"
      >
        {inspectHeader}
        <section className="space-y-2">
          <Label
            className="text-[11px] font-medium text-foreground"
            htmlFor="spine-first-prompt"
          >
            What should the user ask?
          </Label>
          <Textarea
            id="spine-first-prompt"
            value={view.prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder="Enter the user prompt…"
            autoFocus={autoFocusPrompt}
            aria-label="What does the user ask?"
            className={cnBorder(
              !view.prompt.trim() ? evalValidationBorderClass : undefined,
            )}
          />
        </section>

        <section className="space-y-2">
          <Label
            className="text-[11px] font-medium text-foreground"
            htmlFor="spine-first-goal"
          >
            What should a successful answer accomplish?
          </Label>
          <Textarea
            id="spine-first-goal"
            value={expectedOutput ?? ""}
            onChange={(event) => onExpectedOutputChange(event.target.value)}
            rows={3}
            placeholder="States the signed-in account's email address."
            className={cnBorder(undefined)}
          />
          <p className="text-[11px] text-muted-foreground">
            A model grades each run against this.
          </p>
        </section>

        {runControl ? <div>{runControl}</div> : null}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          data-testid="spine-more-options"
          aria-expanded={false}
          onClick={() => setMoreOpen(true)}
        >
          More options
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Require a tool · Add a check · Record a click · Judge settings
        </p>
        {promptStep ? null : null}
      </div>
    );
  }

  // ── the spine ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5" data-testid="case-spine" data-state="spine">
      {inspectHeader}

      <div className="flex items-center justify-between gap-2">
        {runControl ?? <span />}
        {readOnly ? null : recording ? (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onAddCheck}
            >
              Add check
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 text-xs"
              onClick={onStopRecording}
            >
              Stop
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant={recordEntryPrimary ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            disabled={!promptReady}
            onClick={onStartRecording}
            data-testid="simple-case-start-recording"
          >
            Start recording
          </Button>
        )}
      </div>

      {rows.leading.length > 0 ? (
        <section className="space-y-1.5" data-testid="spine-leading-checks">
          <h3 className="text-[11px] font-medium text-foreground">
            Before the first step
          </h3>
          <ul className="space-y-1.5">
            {rows.leading.map((child) => (
              <SpineCheckRow
                key={child.step.id}
                step={child.step}
                row={rowByStepId.get(child.step.id)}
                availableTools={availableTools}
                readOnly={readOnly}
                checkPolicy={checkPolicy}
                status={
                  spineStatus({
                    stepId: child.step.id,
                    kind: "assert",
                    turnIndex: turns[child.index] ?? 0,
                    byId: stepStatusById,
                    byTurn: stepStatusByTurn,
                  }).status
                }
                defaultOpen={addedKey === `step:${child.step.id}`}
                onChange={(next) =>
                  onStepsChange(
                    updateStepCheck(
                      steps,
                      child.step.id,
                      next.assertion as Predicate,
                    ),
                  )
                }
                onRemove={() =>
                  onStepsChange(removeStepById(steps, child.step.id))
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      <ul className="space-y-2" data-testid="spine-actions">
        {rows.actions.map((action) => (
          <ActionRow
            key={action.step.id}
            action={action}
            total={rows.actions.length}
            status={
              spineStatus({
                stepId: action.step.id,
                kind: action.step.kind,
                turnIndex: action.turnIndex,
                byId: stepStatusById,
                byTurn: stepStatusByTurn,
              }).status
            }
            isActive={syncedStepId === action.step.id}
            readOnly={readOnly}
            availableTools={availableTools}
            suiteServers={suiteServers}
            projectServers={projectServers}
            evalValidationBorderClass={evalValidationBorderClass}
            autoFocus={autoFocusPrompt && action.ordinal === 1}
            promptAriaLabel={
              action.ordinal === 1
                ? "What does the user ask?"
                : `Prompt for step ${action.ordinal}`
            }
            onUpdate={(next) => {
              // Route through `writeSimpleCase` ONLY for a prompt that is
              // genuinely `steps[0]` — that is the shape it was written for.
              // Given any other list it treats the case as promptless and
              // PREPENDS a freshly minted prompt, which on a case that opens
              // with a leading check duplicates the prompt and reorders the
              // document. Every other edit is in place, which is what an
              // existing step's text change actually is.
              if (
                next.kind === "prompt" &&
                action.index === 0 &&
                isPromptFirst(steps)
              ) {
                setPrompt(next.prompt);
                return;
              }
              onStepsChange(
                steps.map((step) => (step.id === next.id ? next : step)),
              );
            }}
            onMove={(dir) =>
              onStepsChange(moveActionBlock(steps, action.step.id, dir))
            }
            onRemove={() => requestRemoveAction(action.step.id)}
            onHover={onHoverStep}
            onSelect={
              onSelectStep ? () => onSelectStep(action.step.id) : undefined
            }
          >
            {/* The route question belongs to the action that opens the model
                turn it grades — the first prompt, or the pinned call on a
                model-free case. */}
            {action.ordinal === 1 &&
            (isPromptFirst(steps) || card.route.route?.kind === "locked") ? (
              <ul className="space-y-1.5">
                <RouteRow
                  row={card.route}
                  availableTools={availableTools.map((tool) => tool.name)}
                  readOnly={readOnly}
                  showUnsetError={showUnsetError}
                  negativeContradiction={card.negativeContradiction}
                  onSetTools={setTools}
                  onChooseNoTool={chooseNoTool}
                  onChooseTools={chooseTools}
                  onAddTool={addTool}
                  onSetKind={setKind}
                />
              </ul>
            ) : null}

            {action.checks.length > 0 ? (
              <ul className="space-y-1.5">
                {action.checks.map((child) => (
                  <SpineCheckRow
                    key={child.step.id}
                    step={child.step}
                    row={rowByStepId.get(child.step.id)}
                    availableTools={availableTools}
                    readOnly={readOnly}
                    checkPolicy={checkPolicy}
                    status={
                      spineStatus({
                        stepId: child.step.id,
                        kind: "assert",
                        turnIndex: action.turnIndex,
                        byId: stepStatusById,
                        byTurn: stepStatusByTurn,
                      }).status
                    }
                    defaultOpen={addedKey === `step:${child.step.id}`}
                    onChange={(next) =>
                      onStepsChange(
                        steps.map((step) =>
                          step.id === next.id ? next : step,
                        ),
                      )
                    }
                    onRemove={() =>
                      onStepsChange(removeStepById(steps, child.step.id))
                    }
                    onSelect={
                      onSelectStep
                        ? () => onSelectStep(child.step.id)
                        : undefined
                    }
                  />
                ))}
              </ul>
            ) : null}

            {readOnly ? null : (
              <SuiteScorerLibraryMenu
                kinds={spineLibraryKinds()}
                authorableKinds={authorableKinds}
                triggerLabel="Add a check after this"
                onAdd={(kind) =>
                  addCheckAfter(action.step.id, blankPredicate(kind))
                }
                onAddWidgetCheck={(kind) =>
                  addCheckAfter(
                    action.step.id,
                    defaultWidgetAssertion(kind, ""),
                  )
                }
              />
            )}
          </ActionRow>
        ))}
      </ul>

      <AfterTheRunSection
        authorableKinds={authorableKinds}
        card={card}
        availableTools={availableTools.map((tool) => tool.name)}
        readOnly={readOnly}
        checkPolicy={checkPolicy}
        addedKey={addedKey}
        onCasePredicateChange={(index, next) =>
          onPredicatesChange(updateCaseScorer(predicates, index, next))
        }
        onRemoveCasePredicate={(index) =>
          onPredicatesChange(removeCaseScorer(predicates, index))
        }
        onAddScorer={(predicate) => {
          const next = appendCaseScorer(predicates, predicate);
          setAddedKey(`case:${next.list.length - 1}`);
          onPredicatesChange(next);
        }}
        onApplySuiteScorers={
          card.hiddenSuiteCount > 0 && predicates
            ? () =>
                onPredicatesChange({ mode: "extend", list: predicates.list })
            : undefined
        }
        onExpectedOutputChange={onExpectedOutputChange}
        onJudgeSkippedChange={
          onJudgeConfigOverrideChange
            ? (skipped) =>
                onJudgeConfigOverrideChange(
                  withCaseJudgeSkipped(judgeConfigOverride, skipped),
                )
            : undefined
        }
        onOpenSuiteSettings={onOpenSuiteSettings}
      />

      {pendingDelete ? (
        <DeleteActionPrompt
          plan={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onRemoveOnly={() => {
            onStepsChange(removeStepById(steps, pendingDelete.stepId));
            setPendingDelete(null);
          }}
          onRemoveWithChecks={() => {
            onStepsChange(removeActionWithChecks(steps, pendingDelete.stepId));
            setPendingDelete(null);
          }}
        />
      ) : null}
    </div>
  );
}

function cnBorder(extra: string | undefined): string {
  return [
    "resize-none bg-background font-mono text-sm leading-relaxed",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Removing an action does not remove the checks under it — the runner folds
 * every later assert into the PREVIOUS turn, so a check written to grade turn 2
 * starts grading turn 1. That has to be said before it happens.
 */
function DeleteActionPrompt({
  plan,
  onCancel,
  onRemoveOnly,
  onRemoveWithChecks,
}: {
  plan: DeleteActionPlan & { stepId: string };
  onCancel: () => void;
  onRemoveOnly: () => void;
  onRemoveWithChecks: () => void;
}) {
  const moved = plan.movedChecks + plan.movedFollowers;
  const noun = moved === 1 ? "check" : "checks";
  return (
    <div
      role="alertdialog"
      aria-label="Remove step"
      data-testid="spine-delete-action"
      className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-[11px]"
    >
      <p className="text-foreground">
        {plan.becomesLeading
          ? `Remove this step? Its ${moved} ${noun} would run before any prompt.`
          : `Remove this step? Its ${moved} ${noun} will move under step ${plan.reparentTo?.ordinal} and run after it instead.`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={onRemoveOnly}
        >
          Remove step
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={onRemoveWithChecks}
        >
          Remove step and its {noun}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
