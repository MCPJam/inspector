import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";
import {
  resolveCasePredicates,
  resolveMatchOptions,
  type CasePredicates,
  type EvalMatchOptions,
} from "@/shared/eval-matching";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import {
  ChecksSection,
  ToolCalledWithFields,
} from "../../evals/checks-section";
import {
  caseHasOwnAssertion,
  displayCaseKind,
  inAppStepLabel,
  initialToolsChoice,
  isPromptFirst,
  leftoverSteps,
  matchOptionsForKind,
  MORE_CHECK_GROUPS,
  NEGATIVE_CONTRADICTING_KINDS,
  readSimpleCase,
  readStepChecks,
  removeStepById,
  resolveToolsQuestion,
  turnOrdinalByStepId,
  UNSET_TOOLS_BLOCK_REASON,
  updateStepCheck,
  writeSimpleCase,
  type CaseKind,
  type InAppStep,
  type SimpleCaseTool,
  type ToolsChoice,
} from "./simple-case-model";
import { AlsoInThisCase } from "./also-in-this-case";
import { StepCheckRows } from "./step-check-rows";
import { StatusDot, overlayStatus, type SimpleCaseOverlay } from "./status-dot";

export type { SimpleCaseOverlay };

export type SimpleCaseFormProps = {
  steps: TestStep[];
  onStepsChange: (next: TestStep[]) => void;
  matchOptions?: EvalMatchOptions;
  onMatchOptionsChange: (next: EvalMatchOptions) => void;
  kind?: CaseKind;
  onKindChange?: (next: CaseKind) => void;
  suiteDefaultMatchOptions?: EvalMatchOptions;
  expectedOutput?: string;
  onExpectedOutputChange: (next: string) => void;
  predicates?: CasePredicates;
  onPredicatesChange: (next: CasePredicates | undefined) => void;
  suiteDefaultPredicates?: Predicate[];
  availableTools?: string[];
  isNegativeTest?: boolean;
  onOpenDeepEditor: () => void;
  /**
   * The tool question's stored answer. Controlled by the editor on the
   * Evaluate surface, because it is what decides `isNegativeTest` on save —
   * a value the form reported through an effect would trail the first render
   * that could already save.
   */
  toolsChoice?: ToolsChoice;
  onToolsChoiceChange?: (next: ToolsChoice) => void;
  /**
   * Tools set aside by "No tool should be called", so "Use tools instead" can
   * put them back. Lifted with `toolsChoice`: the choice now survives the trip
   * through the Steps pane, and a stash that did not would leave that undo
   * affordance pointing at nothing.
   */
  stashedTools?: SimpleCaseTool[];
  onStashedToolsChange?: (next: SimpleCaseTool[]) => void;
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
  overlay?: SimpleCaseOverlay | null;
  onSelectInAppStep?: (stepId: string) => void;
};

export function SimpleCaseForm({
  steps,
  onStepsChange,
  matchOptions,
  onMatchOptionsChange,
  kind: persistedKind,
  onKindChange,
  suiteDefaultMatchOptions,
  expectedOutput,
  onExpectedOutputChange,
  predicates,
  onPredicatesChange,
  suiteDefaultPredicates = [],
  availableTools = [],
  isNegativeTest,
  onOpenDeepEditor,
  toolsChoice: controlledToolsChoice,
  onToolsChoiceChange,
  stashedTools: controlledStashedTools,
  onStashedToolsChange,
  evalValidationBorderClass,
  autoFocusPrompt = false,
  validationAttempted = false,
  recording = false,
  onStartRecording,
  onStopRecording,
  onAddCheck,
  recordEntryPrimary = false,
  readOnly = false,
  inspectHeader,
  overlay,
  onSelectInAppStep,
}: SimpleCaseFormProps) {
  const view = useMemo(() => readSimpleCase(steps), [steps]);
  const resolvedMatch = resolveMatchOptions(
    suiteDefaultMatchOptions,
    matchOptions,
  );
  const kind = displayCaseKind(persistedKind, resolvedMatch);

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

  const stepChecks = useMemo(() => readStepChecks(steps), [steps]);
  const leftovers = useMemo(() => leftoverSteps(steps), [steps]);
  const turnOrdinals = useMemo(() => turnOrdinalByStepId(steps), [steps]);
  const promptFirst = isPromptFirst(steps);
  /**
   * A case that does not open on a prompt has no model turn for a route claim
   * to be about — a pinned `toolCall` render check grades the call the SPEC
   * makes, not one the model chose. Lock the whole question rather than only
   * its buttons: leaving Add reachable let a `toolCalledWith` assert be
   * appended to a pinned turn, where it can never match.
   */
  const routeLocked = readOnly || !promptFirst;

  // Open on load when the case already has checks, so a case whose whole
  // grading lives here does not read as an empty form with a disclosure.
  const [moreOpen, setMoreOpen] = useState(
    () => stepChecks.length > 0 || (predicates?.list.length ?? 0) > 0,
  );

  useEffect(() => {
    if (view.tools.length > 0 && toolsChoice !== "tools") {
      setToolsChoice("tools");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.tools, toolsChoice]);

  const resolvedPredicates =
    resolveCasePredicates(suiteDefaultPredicates, predicates) ?? [];

  /**
   * What the tool question shows. `"checks"` means the case names no route but
   * is still graded by something it carries — the shape every CLI- and
   * SDK-authored case has.
   */
  const question = resolveToolsQuestion({
    choice: toolsChoice,
    hasToolAsserts: view.tools.length > 0,
    hasOwnAssertion: caseHasOwnAssertion({
      steps,
      expectedOutput,
      predicates,
    }),
  });

  // A negative case cannot also require a tool call — from the suite, this
  // case, or a step. Advisory: the author's steps are never deleted to satisfy
  // a toggle, and only `toolCalledWith` is rejected outright by the backend.
  const negativeContradiction =
    question === "noTool" &&
    (resolvedPredicates.some((predicate) =>
      NEGATIVE_CONTRADICTING_KINDS.has(predicate.type),
    ) ||
      stepChecks.some((check) =>
        NEGATIVE_CONTRADICTING_KINDS.has(check.predicate.type),
      ));

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
      writeSimpleCase(steps, {
        prompt: view.prompt,
        tools,
        noTool: false,
      }),
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
      {
        id: `assert-${Date.now()}-${view.tools.length + 1}`,
        toolName: name,
        arguments: {},
      },
    ]);
  };

  const caseList = predicates?.list ?? [];
  const setCaseList = (list: Predicate[]) => {
    if (readOnly) return;
    onPredicatesChange(
      list.length === 0 ? undefined : { mode: "extend", list },
    );
  };

  const predicatesByGroup = (kinds: ReadonlyArray<Predicate["type"]>) =>
    caseList.filter((predicate) => kinds.includes(predicate.type));

  const promptReady = view.prompt.trim().length > 0;
  const showUnsetError = validationAttempted && question === "unset";

  return (
    <div className="space-y-6" data-testid="simple-case-form">
      {inspectHeader}
      <div className="flex items-start justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={onOpenDeepEditor}
        >
          Steps
        </Button>
      </div>

      <section className="space-y-2">
        <Label className="text-[11px] font-medium text-foreground">
          User asks
        </Label>
        <Textarea
          value={view.prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          placeholder="Enter the user prompt…"
          autoFocus={autoFocusPrompt}
          aria-label="What does the user ask?"
          readOnly={readOnly || !promptFirst}
          className={cn(
            "resize-none bg-background font-mono text-sm leading-relaxed",
            promptFirst && !view.prompt.trim() && evalValidationBorderClass,
          )}
        />
        {promptFirst ? null : (
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="simple-case-prompt-locked"
          >
            This case does not start with a prompt. Edit it in Steps.
          </p>
        )}
      </section>

      <section className="space-y-2" data-testid="simple-case-in-the-app">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-[11px] font-medium text-foreground">
            In the app
          </Label>
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
        {view.inApp.length === 0 ? null : (
          <div className="space-y-2">
            {view.inApp.map((step) => (
              <InAppRow
                key={step.id}
                step={step}
                status={overlayStatus(overlay, step.id)}
                readOnly={readOnly}
                onSelect={
                  onSelectInAppStep
                    ? () => onSelectInAppStep(step.id)
                    : undefined
                }
                onDelete={() => onStepsChange(removeStepById(steps, step.id))}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4" data-testid="simple-case-check-the-result">
        <Label className="text-[11px] font-medium text-foreground">
          Check the result
        </Label>
        <div className="space-y-2">
          <ToggleGroup
            type="single"
            value={kind}
            onValueChange={(value) => {
              if (value === "capability" || value === "regression") {
                setKind(value);
              }
            }}
            className="gap-0.5"
            aria-label="Case kind"
          >
            <ToggleGroupItem
              value="capability"
              className="h-7 px-2.5 text-xs"
              disabled={readOnly}
            >
              Capability
            </ToggleGroupItem>
            <ToggleGroupItem
              value="regression"
              className="h-7 px-2.5 text-xs"
              disabled={readOnly}
            >
              Regression
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {kind === "regression"
              ? "This case must take one exact route: order and no extra calls."
              : "This case should reach the right tool. Extra calls are allowed."}
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-[11px] font-medium text-foreground">
            {kind === "regression"
              ? "Which route should it take?"
              : "Which tool should handle it?"}
          </Label>
          {promptFirst ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={question === "noTool" ? "secondary" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={chooseNoTool}
                disabled={readOnly}
              >
                No tool should be called
              </Button>
              {question === "noTool" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={chooseTools}
                  disabled={readOnly}
                >
                  Use tools instead
                </Button>
              ) : null}
            </div>
          ) : (
            <p
              className="text-[11px] text-muted-foreground"
              data-testid="simple-case-route-locked"
            >
              This case runs a pinned tool call, so no model route applies. Edit
              it in Steps.
            </p>
          )}
          {question === "checks" && promptFirst ? (
            <p
              className="text-[11px] text-muted-foreground"
              data-testid="simple-case-tools-checks-hint"
            >
              No specific tool is required. This case is graded by the checks
              below.
            </p>
          ) : null}
          {showUnsetError ? (
            <p
              className="text-[11px] text-destructive"
              data-testid="simple-case-tools-unset"
            >
              {UNSET_TOOLS_BLOCK_REASON}
            </p>
          ) : null}
          {negativeContradiction ? (
            <p
              className="text-[11px] text-destructive"
              data-testid="simple-case-negative-contradiction"
            >
              This case says no tool should be called, but a check that requires
              a tool call still applies: from the suite, this case, or a step.
              Those cannot both hold.
            </p>
          ) : null}

          {question !== "noTool" ? (
            <div className="space-y-3">
              {view.tools.map((tool, index) => (
                <div
                  key={tool.id}
                  className="space-y-2 rounded-md border border-border bg-muted/20 p-3"
                  data-testid="simple-case-tool-row"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {kind === "regression" ? `Step ${index + 1}` : "Tool"}
                    </p>
                    <div className="flex items-center gap-1">
                      <StatusDot status={overlayStatus(overlay, tool.id)} />
                      {routeLocked ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground"
                          aria-label={`Remove ${tool.toolName || "tool"}`}
                          onClick={() =>
                            setTools(
                              view.tools.filter((row) => row.id !== tool.id),
                            )
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <ToolCalledWithFields
                    predicate={{
                      type: "toolCalledWith",
                      toolName: tool.toolName,
                      args: {
                        args: kind === "regression" ? tool.arguments : {},
                      },
                    }}
                    onChange={(next) => {
                      if (next.type !== "toolCalledWith") return;
                      setTools(
                        view.tools.map((row) =>
                          row.id === tool.id
                            ? {
                                ...row,
                                toolName: next.toolName,
                                arguments:
                                  kind === "regression"
                                    ? (next.args.args ?? {})
                                    : {},
                              }
                            : row,
                        ),
                      );
                    }}
                    availableTools={availableTools}
                    readOnly={routeLocked}
                  />
                </div>
              ))}
              {routeLocked ? null : (
                <AddToolRow availableTools={availableTools} onAdd={addTool} />
              )}
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label
            htmlFor="simple-case-rubric"
            className="text-[11px] font-medium text-foreground"
          >
            What does a good answer accomplish?
          </Label>
          <Input
            id="simple-case-rubric"
            value={expectedOutput ?? ""}
            onChange={(event) => onExpectedOutputChange(event.target.value)}
            placeholder="One sentence the model grader can score against"
            className="h-8 font-mono text-xs"
            readOnly={readOnly}
          />
          <p className="text-[11px] text-muted-foreground">
            Model grader · advisory. Setting this changes what the judge grades
            against.
          </p>
        </div>

        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-0 text-xs text-muted-foreground"
            >
              More checks
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  moreOpen && "rotate-180",
                )}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-3">
            {MORE_CHECK_GROUPS.map((group) => {
              const rows = predicatesByGroup(group.kinds);
              const stepRows = stepChecks.filter((check) =>
                group.kinds.includes(check.predicate.type),
              );
              const inherited = resolvedPredicates.filter(
                (predicate) =>
                  group.kinds.includes(predicate.type) &&
                  !caseList.includes(predicate),
              );
              return (
                <section key={group.id} className="space-y-2">
                  <h4 className="text-[11px] font-medium text-foreground">
                    {group.label}
                  </h4>
                  {/*
                   * Step-authored checks first, in execution order: they are
                   * graded inline and fail-fast, so a failure here can stop the
                   * case-level checks below from running at all. Editing one
                   * rewrites its step in place — it never becomes a predicate.
                   */}
                  <StepCheckRows
                    checks={stepRows}
                    onChange={(stepId, next) =>
                      onStepsChange(updateStepCheck(steps, stepId, next))
                    }
                    onRemove={(stepId) =>
                      onStepsChange(removeStepById(steps, stepId))
                    }
                    availableTools={availableTools}
                    readOnly={readOnly}
                    overlay={overlay}
                  />
                  <ChecksSection
                    value={rows}
                    onChange={(next) => {
                      const kept = caseList.filter(
                        (predicate) => !group.kinds.includes(predicate.type),
                      );
                      setCaseList([...kept, ...next]);
                    }}
                    availableTools={availableTools}
                    title=""
                    hideEmptyState
                    allowedKinds={group.kinds}
                    readOnly={readOnly}
                  />
                  {inherited.length > 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      {inherited.length} inherited from the suite
                    </p>
                  ) : null}
                </section>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      </section>

      <AlsoInThisCase
        steps={leftovers}
        turnOrdinalByStepId={turnOrdinals}
        onOpenDeepEditor={onOpenDeepEditor}
        readOnly={readOnly}
      />
    </div>
  );
}

function InAppRow({
  step,
  status,
  readOnly,
  onSelect,
  onDelete,
}: {
  step: InAppStep;
  status: EvalStepStatus | undefined;
  readOnly: boolean;
  onSelect?: () => void;
  onDelete: () => void;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
        {inAppStepLabel(step)}
      </span>
      <StatusDot status={status} />
    </>
  );
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2"
      data-testid="simple-case-in-app-row"
    >
      {onSelect ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onSelect}
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {readOnly ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground"
          aria-label={`Remove ${inAppStepLabel(step)}`}
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function AddToolRow({
  availableTools,
  onAdd,
}: {
  availableTools: string[];
  onAdd: (toolName: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-2">
      {availableTools.length > 0 ? (
        <select
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Add a tool"
        >
          <option value="">Pick a tool…</option>
          {availableTools.map((tool) => (
            <option key={tool} value={tool}>
              {tool}
            </option>
          ))}
        </select>
      ) : (
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Tool name"
          aria-label="Add a tool"
          className="h-8 flex-1 text-xs"
        />
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1 text-xs"
        onClick={() => {
          onAdd(name);
          setName("");
        }}
        disabled={!name.trim()}
      >
        <Plus className="h-3.5 w-3.5" />
        Add
      </Button>
    </div>
  );
}
