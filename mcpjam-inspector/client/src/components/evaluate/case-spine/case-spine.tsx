import { EvalAddDrawer } from "./assertion-drawer";
import { isTurnScopablePredicateKind } from "@mcpjam/sdk/predicates";
import { blankStepOfKind } from "@/components/evals/step-fields";
import type { EvalIteration } from "@/components/evals/types";
import {
  joinTrialResults,
  type TrialFacts,
} from "../case-scorecard/trial-results";
import { TrialScorecardRow } from "../case-scorecard/trial-scorecard-row";
import { ScorecardRowView } from "../case-scorecard/scorecard-row";
import { ProvenanceChip } from "../case-scorecard/provenance-chip";
import { afterTheRunRows } from "./case-spine-model";
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
 * Prompt, outcome, and assertions share one editor throughout authoring.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Target, Wrench } from "lucide-react";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  actionRows,
  insertStepAfter,
  newStepId,
  stepTurnIndices,
  type AssertStep,
  type SpineAction,
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
import { authorablePredicateKinds } from "@/components/evals/suite-scorer-table-model";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import { RouteRow, type ToolCatalogStatus } from "../case-scorecard/route-row";
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
import { SpineCheckRow } from "./spine-check-row";
import {
  canRemoveAction,
  deleteActionPlan,
  moveActionBlock,
  removeActionWithChecks,
  replaceActionTools,
  spineStatus,
  toolsByLaterAction,
  type DeleteActionPlan,
} from "./case-spine-model";
import { SuiteRowsDisclosure } from "../case-scorecard/suite-rows-disclosure";

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
  suppressedSuiteStandardCheckIds?: string[];
  snapshotPredicates?: Predicate[];
  availableTools?: AvailableTool[];
  toolsStatus?: ToolCatalogStatus;
  onRetryTools?: () => void;
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
  trialIteration?: EvalIteration;
  trialChain?: TrialFacts["chain"];
  readOnly?: boolean;
  inspectHeader?: ReactNode;
  stepStatusById?: Map<string, EvalStepStatus>;
  stepStatusByTurn?: Map<number, EvalStepStatus>;
  syncedStepId?: string | null;
  onHoverStep?: (stepId: string | null) => void;
  onSelectStep?: (stepId: string) => void;
  /** The Run control. A slot so the spine never owns launching a run. */
  runControl?: ReactNode;
  defaultChecks?: ReactNode;
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
  suiteDefaultPredicates,
  suppressedSuiteStandardCheckIds,
  snapshotPredicates,
  availableTools = [],
  toolsStatus,
  onRetryTools,
  suiteServers = [],
  projectServers,
  isNegativeTest,
  toolsChoice: controlledToolsChoice,
  onToolsChoiceChange,
  stashedTools: controlledStashedTools,
  onStashedToolsChange,
  judgeConfigOverride,
  suiteJudgeConfig,
  suiteJudgeRubric,
  capabilities,
  evalValidationBorderClass,
  autoFocusPrompt,
  validationAttempted = false,
  trialIteration,
  trialChain,
  onPredicatesChange,
  readOnly = false,
  inspectHeader,
  stepStatusById,
  stepStatusByTurn,
  syncedStepId,
  onHoverStep,
  onSelectStep,
  defaultChecks,
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
  /**
   * The prompt whose tool picker "Expect a tool call" opened. A prompt with no
   * tool yet has no block to show one in, so the block is drawn once the author
   * asks for it and stays for as long as the prompt has a tool.
   */
  const [toolPickerFor, setToolPickerFor] = useState<string | null>(null);

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
        suppressedSuiteStandardCheckIds,
        snapshotPredicates,
        expectedOutput,
        judgeConfigOverride,
        suiteJudgeConfig,
        judgePolicy: capabilities?.judges?.goalCompletion.policy,
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
      suppressedSuiteStandardCheckIds,
      snapshotPredicates,
      expectedOutput,
      judgeConfigOverride,
      capabilities?.judges?.goalCompletion.policy,
      suiteJudgeConfig,
      suiteJudgeRubric,
    ],
  );

  const results = useMemo(
    () =>
      trialIteration
        ? new Map(
            joinTrialResults(card.groups, {
              iteration: trialIteration,
              chain: trialChain,
              steps,
              liveStepStatusById: stepStatusById,
            })
              .flatMap((group) => group.rows)
              .map((row) => [row.key, row]),
          )
        : undefined,
    [card.groups, trialIteration, trialChain, steps, stepStatusById],
  );
  const wholeCaseRows = afterTheRunRows(card);
  const ownWholeCaseRows = wholeCaseRows.filter(
    (row) => row.provenance !== "suite",
  );
  const suiteWholeCaseRows = wholeCaseRows.filter(
    (row) => row.provenance === "suite",
  );
  const suiteRowFailed = suiteWholeCaseRows.some((row) => {
    const state = results?.get(row.key)?.result.state;
    return state === "failed" || state === "error";
  });
  // Each later prompt's own tools, and what the first prompt's block keeps.
  const laterTools = useMemo(() => toolsByLaterAction(steps), [steps]);
  const laterToolList = useMemo(
    () => [...laterTools.values()].flat(),
    [laterTools],
  );
  const firstRoute = useMemo(() => {
    const route = card.route.route;
    if (route?.kind !== "tools" || laterToolList.length === 0)
      return card.route;
    const later = new Set(laterToolList.map((tool) => tool.id));
    return {
      ...card.route,
      route: { ...route, tools: route.tools.filter((t) => !later.has(t.id)) },
    };
  }, [card.route, laterToolList]);
  const [emptyPromptId] = useState(() => newStepId("prompt"));
  const rows = useMemo(
    () =>
      actionRows(
        steps.length || readOnly
          ? steps
          : [{ id: emptyPromptId, kind: "prompt", prompt: "" }],
      ),
    [steps, emptyPromptId, readOnly],
  );
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

  const outcomeRef = useRef<HTMLTextAreaElement>(null);
  const checkPolicy = capabilities?.scorers?.checkPolicy === true;
  // What this DEPLOYMENT can evaluate, intersected by the menu with what
  // this SURFACE offers. A kind an older backend rejects is a failed save;
  // one an older runner cannot evaluate fails closed on every trial.
  const authorableKinds = authorablePredicateKinds(
    capabilities?.scorers?.predicateKinds,
  );
  const showUnsetError = validationAttempted && card.unsetBlockReason !== null;
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
    const source = steps.length
      ? steps
      : [{ id: emptyPromptId, kind: "prompt" as const, prompt: "" }];
    onStepsChange(insertStepAfter(source, anchorStepId, step));
  };

  const requestRemoveAction = (stepId: string) => {
    if (readOnly || !canRemoveAction(steps, stepId)) return;
    const plan = deleteActionPlan(steps, stepId);
    if (!plan.needsConfirm) {
      onStepsChange(removeStepById(steps, stepId));
      return;
    }
    setPendingDelete({ ...plan, stepId });
  };

  const renderWholeCaseRow = (row: (typeof wholeCaseRows)[number]) => {
    const result = results?.get(row.key);
    if (result)
      return (
        <TrialScorecardRow
          key={row.key}
          row={result}
          syncedStepId={syncedStepId}
          onSyncStep={onHoverStep}
        />
      );
    return (
      <ScorecardRowView
        key={row.key}
        row={row}
        readOnly={readOnly}
        checkPolicy={checkPolicy}
        availableTools={availableTools.map((tool) => tool.name)}
        onChangePredicate={
          row.provenance === "case"
            ? (next) =>
                onPredicatesChange({
                  mode: predicates?.mode ?? "extend",
                  list: (predicates?.list ?? []).map((item, index) =>
                    index === row.predicateIndex ? next : item,
                  ),
                })
            : undefined
        }
        onRemove={
          row.provenance === "case"
            ? () =>
                onPredicatesChange({
                  mode: predicates?.mode ?? "extend",
                  list: (predicates?.list ?? []).filter(
                    (_, index) => index !== row.predicateIndex,
                  ),
                })
            : undefined
        }
      />
    );
  };

  // ── which prompt draws a tools block ───────────────────────────────────────

  const routeKind = card.route.route?.kind;
  // "Expect a tool call" needs somewhere to write. A negative case forbids the
  // call, a pinned-first one has no model turn for it, and an empty draft has
  // no prompt step yet for a tool to follow.
  const canExpectTool =
    !readOnly &&
    steps.length > 0 &&
    routeKind !== "noTool" &&
    routeKind !== "locked";
  const firstBlockShown = (action: SpineAction) =>
    action.ordinal === 1 &&
    (view.tools.length > 0 ||
      toolsChoice === "noTool" ||
      routeKind === "locked" ||
      (canExpectTool && toolPickerFor === action.step.id));
  const laterBlockShown = (action: SpineAction) =>
    action.ordinal > 1 &&
    ((laterTools.has(action.step.id) && routeKind === "tools") ||
      (canExpectTool && toolPickerFor === action.step.id));
  /** A later prompt's tools block, drawn from the case's route or, when the
   * case has no tool yet, from an empty one. */
  const laterRow = (action: SpineAction) => {
    const tools = laterTools.get(action.step.id) ?? [];
    const route = card.route.route;
    return {
      ...card.route,
      key: `${card.route.key}:${action.step.id}`,
      route:
        route?.kind === "tools"
          ? { ...route, tools }
          : {
              kind: "tools" as const,
              tools,
              matchMode: "capability" as const,
              resolvedMatch: resolvedMatch,
            },
    };
  };

  // ── the spine ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5" data-testid="case-spine" data-state="spine">
      {inspectHeader}

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
                trialRow={results?.get(
                  rowByStepId.get(child.step.id)?.key ?? "",
                )}
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
                (steps.length === 0 || isPromptFirst(steps))
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
            canRemove={canRemoveAction(steps, action.step.id)}
            onRemove={() => requestRemoveAction(action.step.id)}
            onHover={onHoverStep}
            onSelect={
              onSelectStep ? () => onSelectStep(action.step.id) : undefined
            }
          >
            {readOnly ? null : (
              <EvalAddDrawer
                className="w-full"
                triggerLabel="Add assertion or action"
                authorableKinds={authorableKinds}
                onOutcomeFocus={() => {
                  outcomeRef.current?.scrollIntoView?.({ block: "center" });
                  outcomeRef.current?.focus();
                }}
                onSelect={(choice) => {
                  if (choice.kind === "outcome") return;
                  if (
                    choice.kind === "check" &&
                    !isTurnScopablePredicateKind(choice.predicateKind)
                  ) {
                    onPredicatesChange({
                      mode: predicates?.mode ?? "extend",
                      list: [
                        ...(predicates?.list ?? []),
                        blankPredicate(choice.predicateKind),
                      ],
                    });
                    return;
                  }
                  if (choice.kind === "step") {
                    const step = blankStepOfKind(choice.stepKind, suiteServers);
                    const source = steps.length
                      ? steps
                      : [
                          {
                            id: emptyPromptId,
                            kind: "prompt" as const,
                            prompt: "",
                          },
                        ];
                    onStepsChange(
                      insertStepAfter(source, action.step.id, step),
                    );
                  } else {
                    addCheckAfter(
                      action.step.id,
                      choice.kind === "check"
                        ? blankPredicate(choice.predicateKind)
                        : defaultWidgetAssertion(choice.widgetKind, ""),
                    );
                  }
                }}
              />
            )}
            {action.ordinal === 1 && defaultChecks ? (
              <div className="flex justify-end">{defaultChecks}</div>
            ) : null}

            {/* Every prompt can expect a tool call. The block that holds them
                is drawn only for a prompt that already has one, so a prompt
                without one offers the way in. */}
            {action.step.kind === "prompt" &&
            canExpectTool &&
            !firstBlockShown(action) &&
            !laterBlockShown(action) ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-dashed text-xs"
                  data-testid="spine-expect-tool"
                  onClick={() => setToolPickerFor(action.step.id)}
                >
                  <Wrench className="size-3.5" aria-hidden />
                  Expect a tool call
                </Button>
              </div>
            ) : null}

            {/* The route question belongs to the action that opens the model
                turn it grades — the first prompt, or the pinned call on a
                model-free case. */}
            {firstBlockShown(action) ? (
              <ul className="space-y-1.5">
                {results?.get(card.route.key) ? (
                  <TrialScorecardRow row={results.get(card.route.key)!} />
                ) : (
                  <RouteRow
                    row={firstRoute}
                    availableTools={availableTools.map((tool) => tool.name)}
                    toolsStatus={toolsStatus}
                    onRetryTools={onRetryTools}
                    readOnly={readOnly}
                    showUnsetError={showUnsetError}
                    negativeContradiction={card.negativeContradiction}
                    onSetTools={(tools) =>
                      setTools([...tools, ...laterToolList])
                    }
                    onChooseNoTool={chooseNoTool}
                    onChooseTools={chooseTools}
                    onAddTool={(toolName) => {
                      setToolPickerFor(null);
                      addTool(toolName);
                    }}
                    onSetKind={setKind}
                  />
                )}
              </ul>
            ) : null}

            {/* A later prompt's own tools, under that prompt: the runner grades
                them against its turn. */}
            {laterBlockShown(action) ? (
              <ul className="space-y-1.5">
                <RouteRow
                  turnScoped
                  row={laterRow(action)}
                  availableTools={availableTools.map((tool) => tool.name)}
                  toolsStatus={toolsStatus}
                  onRetryTools={onRetryTools}
                  readOnly={readOnly}
                  showUnsetError={false}
                  negativeContradiction={false}
                  onSetTools={(next) =>
                    !readOnly &&
                    onStepsChange(
                      replaceActionTools(
                        steps,
                        action.step.id,
                        laterTools.get(action.step.id) ?? [],
                        next,
                      ),
                    )
                  }
                  onAddTool={(toolName) => {
                    const name = toolName.trim();
                    if (readOnly || !name) return;
                    const current = laterTools.get(action.step.id) ?? [];
                    setToolPickerFor(null);
                    onStepsChange(
                      replaceActionTools(steps, action.step.id, current, [
                        ...current,
                        {
                          id: newStepId("assert"),
                          toolName: name,
                          arguments: {},
                        },
                      ]),
                    );
                  }}
                  onChooseNoTool={() => {}}
                  onChooseTools={() => {}}
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
                    trialRow={results?.get(
                      rowByStepId.get(child.step.id)?.key ?? "",
                    )}
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
          </ActionRow>
        ))}
      </ul>

      {/* One outcome for the whole case, not one per prompt. It sits AFTER
          the last action because the judge grades the end state of the run:
          rendering it under prompt 1 read as "prompt 1's outcome", and a
          second prompt then looked broken for having none. Per-step
          expectations are the checks under each action. */}
      <section
        className="space-y-2"
        data-testid="spine-expected-outcome-section"
      >
        <div className="flex items-center gap-2">
          <Label
            className="text-lg font-semibold text-primary"
            htmlFor="spine-expected-outcome"
          >
            <Target className="size-4" aria-hidden="true" />
            Expected Outcome
          </Label>
          <ProvenanceChip provenance="judge" />
        </div>
        <Textarea
          id="spine-expected-outcome"
          ref={outcomeRef}
          value={expectedOutput ?? ""}
          onChange={(event) => onExpectedOutputChange(event.target.value)}
          rows={3}
          readOnly={readOnly}
          placeholder={
            readOnly
              ? "No expected outcome captured"
              : "One sentence the judge scores against"
          }
          className={cnBorder(undefined)}
        />
      </section>

      {wholeCaseRows.length > 0 && (
        <section className="space-y-2" aria-label="Whole-case assertions">
          <h3 className="text-sm font-semibold">Whole-case assertions</h3>
          {ownWholeCaseRows.length > 0 ? (
            <ul className="space-y-1.5">
              {ownWholeCaseRows.map(renderWholeCaseRow)}
            </ul>
          ) : null}
          {suiteWholeCaseRows.length > 0 ? (
            <SuiteRowsDisclosure
              rows={suiteWholeCaseRows}
              defaultOpen={suiteRowFailed}
            >
              <ul className="space-y-1.5">
                {suiteWholeCaseRows.map(renderWholeCaseRow)}
              </ul>
            </SuiteRowsDisclosure>
          ) : null}
        </section>
      )}
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
  return ["resize-none bg-background text-foreground", extra ?? ""]
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
