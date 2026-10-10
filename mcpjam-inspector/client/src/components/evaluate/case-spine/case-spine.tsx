import { SpineDragProvider } from "./spine-drag";
import { reorderSpineSteps, reorderRouteToolChecks } from "./case-spine-model";
import { RouteCheckRow } from "./route-check-row";
import type { DragEndEvent } from "@dnd-kit/core";
import { CheckDraftBoundary } from "@/components/evals/checks-section";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@mcpjam/design-system/dialog";
import { Target } from "lucide-react";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Switch } from "@mcpjam/design-system/switch";
import {
  actionRows,
  insertStepAfter,
  newStepId,
  stepTurnIndices,
  type SpineAction,
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
import { withCaseJudgeSkipped } from "../case-scorecard/case-scorecard-model";

export type CaseSpineProps = {
  onDraftValidityChange?: (invalid: boolean) => void;
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
  onDraftValidityChange,
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
  onJudgeConfigOverrideChange,
  onOpenSuiteSettings,
  recording = false,
  onStartRecording,
  onStopRecording,
  onAddCheck,
  recordEntryPrimary = false,
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
  const toolArgSchemas = useMemo(
    () =>
      Object.fromEntries(
        availableTools.map((tool) => [
          tool.name,
          tool.inputSchema?.properties ?? {},
        ]),
      ),
    [availableTools],
  );
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
  const stashedToolChecks = useRef<{ step: AssertStep; preceding: string[] }[]>(
    [],
  );
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
  // Local identities follow rows through reorders; they never enter saved predicates.
  const caseDragIds = useRef<string[]>([]);
  const predicateCount = predicates?.list.length ?? 0;
  while (caseDragIds.current.length < predicateCount)
    caseDragIds.current.push(`case-drag:${newStepId("row")}`);
  caseDragIds.current.length = predicateCount;
  const reorderRows = ({ active, over }: DragEndEvent) => {
    if (
      readOnly ||
      !over ||
      active.id === over.id ||
      active.data.current?.phase !== over.data.current?.phase ||
      active.data.current?.kind !== over.data.current?.kind
    )
      return;
    if (active.data.current?.phase === "steps") {
      const next = reorderSpineSteps(
        steps,
        String(active.id).slice(5),
        String(over.id).slice(5),
      );
      if (next !== steps) onStepsChange(next);
      return;
    }
    const from = caseDragIds.current.indexOf(String(active.id));
    const to = caseDragIds.current.indexOf(String(over.id));
    if (from < 0 || to < 0 || !predicates) return;
    const list = [...predicates.list];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved!);
    const newestId = addedKey?.startsWith("case:")
      ? caseDragIds.current[Number(addedKey.slice(5))]
      : undefined;
    const [id] = caseDragIds.current.splice(from, 1);
    caseDragIds.current.splice(to, 0, id!);
    if (newestId) setAddedKey(`case:${caseDragIds.current.indexOf(newestId)}`);
    onPredicatesChange({ ...predicates, list });
  };

  const addedPromptRef = useRef<HTMLTextAreaElement>(null);
  const [pendingDelete, setPendingDelete] = useState<
    (DeleteActionPlan & { stepId: string }) | null
  >(null);

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
  const noToolsCheck = !readOnly && card.route.route?.kind === "noTool";
  const exactOrderCheck =
    !readOnly &&
    !noToolsCheck &&
    view.tools.length > 0 &&
    resolvedMatch.toolCallOrder === "strict" &&
    resolvedMatch.maxExtraToolCalls === 0;
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
    if (
      steps.some(
        (step) =>
          step.kind === "assert" &&
          "type" in step.assertion &&
          step.assertion.type === "toolCalledWith",
      )
    ) {
      stashedToolChecks.current = steps.flatMap((step, index) =>
        step.kind === "assert" &&
        "type" in step.assertion &&
        step.assertion.type === "toolCalledWith"
          ? [
              {
                step,
                preceding: steps
                  .slice(0, index)
                  .map((item) => item.id)
                  .reverse(),
              },
            ]
          : [],
      );
    }
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
    if (view.tools.length === 0 && stashedToolChecks.current.length > 0) {
      const next = [...steps];
      for (const { step, preceding } of stashedToolChecks.current) {
        if (next.some((item) => item.id === step.id)) continue;
        const anchor = preceding.find((id) =>
          next.some((item) => item.id === id),
        );
        const index = anchor
          ? next.findIndex((item) => item.id === anchor)
          : next.findIndex((item) => item.kind === "prompt");
        next.splice(index + 1, 0, step);
      }
      onStepsChange(next);
      return;
    }
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
        key={
          row.provenance === "case"
            ? caseDragIds.current[row.predicateIndex!]
            : row.key
        }
        dragId={
          row.provenance === "case"
            ? caseDragIds.current[row.predicateIndex!]
            : undefined
        }
        row={row}
        readOnly={readOnly}
        checkPolicy={checkPolicy}
        onOpenSuiteSettings={onOpenSuiteSettings}
        paper={!readOnly}
        newest={addedKey === row.key}
        availableTools={availableTools.map((tool) => tool.name)}
        toolArgSchemas={toolArgSchemas}
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
            ? () => {
                const removed = row.predicateIndex!;
                caseDragIds.current.splice(removed, 1);
                if (addedKey?.startsWith("case:")) {
                  const newestIndex = Number(addedKey.slice(5));
                  if (newestIndex === removed) setAddedKey(null);
                  else if (newestIndex > removed)
                    setAddedKey(`case:${newestIndex - 1}`);
                }
                onPredicatesChange({
                  mode: predicates?.mode ?? "extend",
                  list: (predicates?.list ?? []).filter(
                    (_, index) => index !== row.predicateIndex,
                  ),
                });
              }
            : undefined
        }
      />
    );
  };

  const renderAdd = (anchor: SpineAction, compact = false, filled = true) => (
    <>
      {readOnly ? null : (
        <section
          className={filled && !compact ? "border-t border-border" : undefined}
          aria-label={`Assertions or actions after step ${anchor.ordinal}`}
        >
          <EvalAddDrawer
            allowRouteChecks={card.route.route?.kind !== "locked"}
            className={`${filled && !compact ? "h-12" : "h-9"} w-full rounded-none border-0 border-solid bg-card text-[13px] font-medium text-secondary-foreground shadow-none`}
            triggerLabel="Add assertion or action"
            onPromptFocus={() => addedPromptRef.current?.focus()}
            authorableKinds={authorableKinds}
            onOutcomeFocus={() => {
              outcomeRef.current?.scrollIntoView?.({ block: "center" });
              outcomeRef.current?.focus();
            }}
            onSelect={(choice) => {
              if (choice.kind === "outcome") return;
              if (choice.kind === "route-check") {
                if (choice.routeKind === "noTools") {
                  chooseNoTool();
                  setAddedKey("route:noTools");
                } else {
                  if (toolsChoice === "noTool") chooseTools();
                  setKind("regression");
                  if (
                    view.tools.length === 0 &&
                    (toolsChoice !== "noTool" || stashedTools.length === 0)
                  ) {
                    addCheckAfter(
                      rows.actions[0]?.step.id ?? emptyPromptId,
                      blankPredicate("toolCalledWith"),
                    );
                  }
                  setAddedKey("route:exactOrder");
                }
                return;
              }
              if (
                choice.kind === "check" &&
                !isTurnScopablePredicateKind(choice.predicateKind)
              ) {
                setAddedKey(`case:${predicates?.list.length ?? 0}`);
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
                setAddedKey(`action:${step.id}`);
                const source = steps.length
                  ? steps
                  : [
                      {
                        id: emptyPromptId,
                        kind: "prompt" as const,
                        prompt: "",
                      },
                    ];
                onStepsChange(insertStepAfter(source, anchor.step.id, step));
              } else {
                addCheckAfter(
                  anchor.step.id,
                  choice.kind === "check"
                    ? blankPredicate(choice.predicateKind)
                    : defaultWidgetAssertion(choice.widgetKind, ""),
                );
              }
            }}
          />
        </section>
      )}
    </>
  );
  const renderGroupSettings = (action: SpineAction) => (
    <>
      {action.ordinal === 1 && defaultChecks ? (
        <div className="flex justify-end">{defaultChecks}</div>
      ) : null}
    </>
  );
  const renderActionContents = (action: SpineAction) => (
    <>
      {/* The route question belongs to the action that opens the model
                turn it grades — the first prompt, or the pinned call on a
                model-free case. */}
      {action.ordinal === 1 &&
      (readOnly || card.route.route?.kind === "locked") &&
      (view.tools.length > 0 ||
        toolsChoice === "noTool" ||
        card.route.route?.kind === "locked") ? (
        <ul className="divide-y divide-border">
          {results?.get(card.route.key) ? (
            <TrialScorecardRow row={results.get(card.route.key)!} />
          ) : (
            <RouteRow
              toolArgSchemas={toolArgSchemas}
              paper={!readOnly}
              row={firstRoute}
              newestStepId={
                addedKey?.startsWith("step:") ? addedKey.slice(5) : undefined
              }
              availableTools={availableTools.map((tool) => tool.name)}
              toolsStatus={toolsStatus}
              onRetryTools={onRetryTools}
              readOnly={readOnly}
              showUnsetError={showUnsetError}
              negativeContradiction={card.negativeContradiction}
              onSetTools={(tools) => setTools([...tools, ...laterToolList])}
              onChooseNoTool={chooseNoTool}
              onChooseTools={chooseTools}
              onAddTool={addTool}
              onSetKind={setKind}
            />
          )}
        </ul>
      ) : null}

      {/* A later prompt's own tools, under that prompt: the runner grades
                them against its turn. */}
      {readOnly &&
      action.ordinal > 1 &&
      laterTools.has(action.step.id) &&
      card.route.route?.kind === "tools" ? (
        <ul className="divide-y divide-border">
          <RouteRow
            toolArgSchemas={toolArgSchemas}
            paper={!readOnly}
            turnScoped
            newestStepId={
              addedKey?.startsWith("step:") ? addedKey.slice(5) : undefined
            }
            row={{
              ...card.route,
              key: `${card.route.key}:${action.step.id}`,
              route: {
                ...card.route.route,
                tools: laterTools.get(action.step.id)!,
              },
            }}
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
                  laterTools.get(action.step.id)!,
                  next,
                ),
              )
            }
            onAddTool={(toolName) => {
              const name = toolName.trim();
              if (readOnly || !name) return;
              const current = laterTools.get(action.step.id)!;
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
        <ul className="divide-y divide-border">
          {action.checks.map((child) =>
            !readOnly &&
            "type" in child.step.assertion &&
            child.step.assertion.type === "toolCalledWith" &&
            card.route.route?.kind === "tools" ? (
              <RouteRow
                toolArgSchemas={toolArgSchemas}
                key={child.step.id}
                paper
                turnScoped
                toolPredicate={child.step.assertion}
                onChangeToolPredicate={(assertion) =>
                  onStepsChange(
                    steps.map((step) =>
                      step.id === child.step.id
                        ? { ...child.step, assertion }
                        : step,
                    ),
                  )
                }
                newestStepId={
                  addedKey?.startsWith("step:") ? addedKey.slice(5) : undefined
                }
                row={{
                  ...card.route,
                  key: `step:${child.step.id}`,
                  route: {
                    ...card.route.route,
                    tools: [
                      {
                        id: child.step.id,
                        toolName: child.step.assertion.toolName,
                        arguments: child.step.assertion.args?.args ?? {},
                      },
                    ],
                  },
                }}
                availableTools={availableTools.map((tool) => tool.name)}
                toolsStatus={toolsStatus}
                onRetryTools={onRetryTools}
                readOnly={false}
                showUnsetError={false}
                negativeContradiction={false}
                onSetTools={(next) => {
                  const tool = next[0];
                  if (!tool) {
                    onStepsChange(removeStepById(steps, child.step.id));
                    return;
                  }
                  onStepsChange(
                    steps.map((step) => {
                      if (
                        step.id !== child.step.id ||
                        step.kind !== "assert" ||
                        !("type" in step.assertion) ||
                        step.assertion.type !== "toolCalledWith"
                      )
                        return step;
                      return {
                        ...step,
                        assertion: {
                          ...step.assertion,
                          toolName: tool.toolName,
                          args: {
                            ...step.assertion.args,
                            args: tool.arguments ?? {},
                          },
                        },
                      };
                    }),
                  );
                }}
                onChooseNoTool={chooseNoTool}
                onChooseTools={chooseTools}
                onAddTool={addTool}
                onSetKind={setKind}
              />
            ) : (
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
                newest={addedKey === `step:${child.step.id}`}
                defaultOpen={addedKey === `step:${child.step.id}`}
                onChange={(next) =>
                  onStepsChange(
                    steps.map((step) => (step.id === next.id ? next : step)),
                  )
                }
                onRemove={() =>
                  onStepsChange(removeStepById(steps, child.step.id))
                }
                onSelect={
                  onSelectStep ? () => onSelectStep(child.step.id) : undefined
                }
              />
            ),
          )}
        </ul>
      ) : null}
    </>
  );
  const renderAction = (
    action: SpineAction,
    following: SpineAction[] | null = null,
  ): ReactNode => (
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
      promptRef={
        addedKey === `action:${action.step.id}` ? addedPromptRef : undefined
      }
      newest={addedKey === `action:${action.step.id}`}
      addAfter={renderAdd(action, true)}
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
        onStepsChange(steps.map((step) => (step.id === next.id ? next : step)));
      }}
      onMove={(dir) =>
        onStepsChange(moveActionBlock(steps, action.step.id, dir))
      }
      canRemove={canRemoveAction(steps, action.step.id)}
      onRemove={() => requestRemoveAction(action.step.id)}
      onHover={onHoverStep}
      onSelect={onSelectStep ? () => onSelectStep(action.step.id) : undefined}
    >
      {following !== null ? (
        <section
          className="space-y-2"
          aria-label={`Assertions or actions after step ${action.ordinal}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {" "}
            <h3 className="text-base font-semibold leading-6 text-card-foreground">
              Assertions or actions
            </h3>{" "}
            {action.ordinal === 1 && onStartRecording ? (
              <div className="flex justify-end gap-2">
                {recording ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onAddCheck}
                    >
                      Add check
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={onStopRecording}
                    >
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant={recordEntryPrimary ? "default" : "outline"}
                    size="sm"
                    disabled={!view.prompt.trim()}
                    onClick={onStartRecording}
                    data-testid="simple-case-start-recording"
                  >
                    Start recording
                  </Button>
                )}
              </div>
            ) : null}
          </div>
          <div
            className="overflow-hidden rounded-xl border border-border bg-card"
            data-testid="paper-action-group"
          >
            {renderActionContents(action)}
            {following.length > 0 ? (
              <ul className="divide-y divide-border border-t border-border">
                {following.map((item) => renderAction(item))}
              </ul>
            ) : null}
            {renderAdd(
              following.at(-1) ?? action,
              false,
              action.checks.length > 0 || following.length > 0,
            )}
          </div>
          {renderGroupSettings(action)}
        </section>
      ) : (
        renderActionContents(action)
      )}
    </ActionRow>
  );
  const actionGroups: SpineAction[][] = [];
  for (const action of rows.actions) {
    if (action.step.kind === "prompt" || actionGroups.length === 0)
      actionGroups.push([]);
    actionGroups[actionGroups.length - 1]!.push(action);
  }

  // ── the spine ──────────────────────────────────────────────────────────────

  return (
    <SpineDragProvider
      disabled={readOnly}
      items={[
        ...steps.map((step) => `step:${step.id}`),
        ...caseDragIds.current,
      ]}
      onReorder={reorderRows}
    >
      <CheckDraftBoundary onValidityChange={onDraftValidityChange}>
        <div
          className="space-y-5 font-sans antialiased"
          data-testid="case-spine"
          data-state="spine"
        >
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
                    newest={addedKey === `step:${child.step.id}`}
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

          <ul className="space-y-5" data-testid="spine-actions">
            {actionGroups.map(([first, ...following]) =>
              renderAction(first!, following),
            )}
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
                className="text-lg leading-7 font-semibold text-card-foreground"
                htmlFor="spine-expected-outcome"
              >
                <Target className="size-4" aria-hidden="true" />
                Expected outcome
              </Label>
              <ProvenanceChip provenance="judge" />
            </div>
            <p
              id="spine-expected-outcome-help"
              className="text-sm leading-5 text-secondary-foreground dark:text-muted-foreground"
            >
              Describe what success looks like. The LLM as a judge checks whether this goal was met.
            </p>
            <Textarea
              id="spine-expected-outcome"
              ref={outcomeRef}
              value={expectedOutput ?? ""}
              onChange={(event) => onExpectedOutputChange(event.target.value)}
              rows={2}
              aria-describedby="spine-expected-outcome-help"
              readOnly={readOnly}
              placeholder={
                readOnly
                  ? "No expected outcome captured"
                  : "Describe the outcome you expect…"
              }
              className="min-h-[72px] resize-y rounded-lg border-input bg-card px-3.5 py-3 font-sans text-[15px] leading-[22px] text-card-foreground md:text-[15px]"
            />
            {!readOnly &&
            onJudgeConfigOverrideChange &&
            card.judge.judge &&
            card.judge.judge.suiteMode !== "off" ? (
              <div className="flex items-center gap-2 pt-1">
                <Switch
                  id="case-judge-skip"
                  checked={card.judge.judge.skippedForCase}
                  onCheckedChange={(skipped) =>
                    onJudgeConfigOverrideChange(
                      withCaseJudgeSkipped(judgeConfigOverride, skipped),
                    )
                  }
                  aria-label="Skip the judge for this case"
                />
                <Label
                  htmlFor="case-judge-skip"
                  className="text-xs font-normal text-foreground"
                >
                  Skip the judge for this case
                </Label>
              </div>
            ) : null}
          </section>

          {(wholeCaseRows.length > 0 || noToolsCheck || exactOrderCheck) && (
            <section
              className="space-y-2"
              aria-label="After run checks"
              data-testid="spine-after-run-checks"
            >
              <h3 className="text-base leading-6 font-semibold text-card-foreground">
                After run checks
              </h3>
              {(noToolsCheck || exactOrderCheck) && (
                <ul className="overflow-hidden rounded-xl border border-border bg-card">
                  <RouteCheckRow
                    kind={noToolsCheck ? "noTools" : "exactOrder"}
                    tools={view.tools}
                    newest={
                      addedKey ===
                      `route:${noToolsCheck ? "noTools" : "exactOrder"}`
                    }
                    onRemove={() => {
                      if (noToolsCheck) chooseTools();
                      else setKind("capability");
                    }}
                    onAddTool={() =>
                      addCheckAfter(
                        rows.actions[0]?.step.id ?? emptyPromptId,
                        blankPredicate("toolCalledWith"),
                      )
                    }
                    onToolChange={(id, toolName) =>
                      onStepsChange(
                        steps.map((step) => {
                          if (
                            step.id !== id ||
                            step.kind !== "assert" ||
                            !("type" in step.assertion) ||
                            step.assertion.type !== "toolCalledWith"
                          )
                            return step;
                          return {
                            ...step,
                            assertion: { ...step.assertion, toolName },
                          };
                        }),
                      )
                    }
                    onToolRemove={(id) =>
                      onStepsChange(removeStepById(steps, id))
                    }
                    onReorder={(from, to) =>
                      onStepsChange(reorderRouteToolChecks(steps, from, to))
                    }
                  />
                  {card.negativeContradiction && (
                    <li className="px-8 py-2 text-xs text-destructive">
                      This check conflicts with another check that requires a
                      tool call.
                    </li>
                  )}
                </ul>
              )}
              {ownWholeCaseRows.length > 0 ? (
                <ul className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
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
                onStepsChange(
                  removeActionWithChecks(steps, pendingDelete.stepId),
                );
                setPendingDelete(null);
              }}
            />
          ) : null}
        </div>
      </CheckDraftBoundary>
    </SpineDragProvider>
  );
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent role="alertdialog" data-testid="spine-delete-action">
        <DialogHeader>
          <DialogTitle>Remove step</DialogTitle>
          <DialogDescription>
            {plan.becomesLeading
              ? `Remove this step? Its ${moved} ${noun} would run before any prompt.`
              : `Remove this step? Its ${moved} ${noun} will move under step ${plan.reparentTo?.ordinal} and run after it instead.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap">
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
