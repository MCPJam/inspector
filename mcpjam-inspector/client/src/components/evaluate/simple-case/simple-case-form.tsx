import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { cn } from "@/lib/utils";
import {
  resolveMatchOptions,
  type CasePredicates,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";
import { isInteractStep, newStepId, type TestStep } from "@/shared/steps";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type {
  EvalJudgeConfig,
  EvalJudgeConfigOverride,
  EvalJudgeRubric,
} from "../../evals/types";
import {
  inAppStepLabel,
  initialToolsChoice,
  isPromptFirst,
  leftoverSteps,
  matchOptionsForKind,
  readSimpleCase,
  removeStepById,
  turnOrdinalByStepId,
  updateStepCheck,
  writeSimpleCase,
  type CaseKind,
  type InAppStep,
  type SimpleCaseTool,
  type ToolsChoice,
} from "./simple-case-model";
import {
  appendCaseScorer,
  removeCaseScorer,
  updateCaseScorer,
  withCaseJudgeSkipped,
} from "../case-scorecard/case-scorecard-model";
import { CaseScorecard } from "../case-scorecard/case-scorecard";
import { AlsoInThisCase } from "./also-in-this-case";
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
  /**
   * The one per-case judge control the backend admits (opt out). Absent on a
   * surface that cannot write it, and the switch then does not render.
   */
  judgeConfigOverride?: EvalJudgeConfigOverride;
  onJudgeConfigOverrideChange?: (
    next: EvalJudgeConfigOverride | undefined,
  ) => void;
  /** Read-only judge facts: which model grades this, and against what. */
  suiteJudgeConfig?: EvalJudgeConfig;
  suiteJudgeRubric?: EvalJudgeRubric;
  /** Gates the role control. Unavailable behaves exactly like unsupported. */
  capabilities?: SuiteCapabilities | null;
  /**
   * The RESOLVED list a frozen trial was graded against. Supplying it replaces
   * the case and suite rows, because that list cannot say which was which.
   */
  snapshotPredicates?: Predicate[];
  onOpenSuiteSettings?: () => void;
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
  judgeConfigOverride,
  onJudgeConfigOverrideChange,
  suiteJudgeConfig,
  suiteJudgeRubric,
  capabilities,
  snapshotPredicates,
  onOpenSuiteSettings,
}: SimpleCaseFormProps) {
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

  const leftovers = useMemo(() => leftoverSteps(steps), [steps]);
  const turnOrdinals = useMemo(() => turnOrdinalByStepId(steps), [steps]);
  const promptFirst = isPromptFirst(steps);
  /*
   * "In the app" lists what the recorder captured — clicks and typing. A
   * widget assertion is a CHECK, and it now files under Scorers with every
   * other check rather than sitting apart from the things it is graded with.
   * Its position in `steps` is untouched, so it still runs where it ran.
   */
  const inAppInteractions = useMemo(
    () => view.inApp.filter(isInteractStep),
    [view.inApp],
  );

  /**
   * A newly added scorer opens expanded. A blank check has empty fields and a
   * one-line row would show only its kind, leaving nothing to fill in.
   */
  const [addedRowKey, setAddedRowKey] = useState<string | null>(null);

  const scorecardInput = useMemo(
    () => ({
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
  useEffect(() => {
    if (view.tools.length > 0 && toolsChoice !== "tools") {
      setToolsChoice("tools");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.tools, toolsChoice]);

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
        id: newStepId("assert"),
        toolName: name,
        arguments: {},
      },
    ]);
  };

  const promptReady = view.prompt.trim().length > 0;

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
        {inAppInteractions.length === 0 ? null : (
          <div className="space-y-2">
            {inAppInteractions.map((step) => (
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

      <CaseScorecard
        input={scorecardInput}
        availableTools={availableTools}
        readOnly={readOnly}
        checkPolicy={capabilities?.scorers?.checkPolicy === true}
        overlay={overlay}
        validationAttempted={validationAttempted}
        addedRowKey={addedRowKey}
        onStepPredicateChange={(stepId, next) =>
          onStepsChange(updateStepCheck(steps, stepId, next))
        }
        onRemoveStep={(stepId) => onStepsChange(removeStepById(steps, stepId))}
        onSelectStep={onSelectInAppStep}
        onCasePredicateChange={(index, next) =>
          onPredicatesChange(updateCaseScorer(predicates, index, next))
        }
        onRemoveCasePredicate={(index) =>
          onPredicatesChange(removeCaseScorer(predicates, index))
        }
        onAddScorer={(predicate) => {
          const next = appendCaseScorer(predicates, predicate);
          setAddedRowKey(`case:${next.list.length - 1}`);
          onPredicatesChange(next);
        }}
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
        onSetTools={setTools}
        onChooseNoTool={chooseNoTool}
        onChooseTools={chooseTools}
        onAddTool={addTool}
        onSetKind={setKind}
      />

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

