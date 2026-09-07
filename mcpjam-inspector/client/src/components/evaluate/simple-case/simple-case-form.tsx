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
  displayCaseKind,
  inAppStepLabel,
  initialToolsChoice,
  matchOptionsForKind,
  MORE_CHECK_GROUPS,
  readSimpleCase,
  removeStepById,
  UNSET_TOOLS_BLOCK_REASON,
  writeSimpleCase,
  type CaseKind,
  type InAppStep,
  type SimpleCaseTool,
  type ToolsChoice,
} from "./simple-case-model";

/** Per-step verdicts of the selected trial, shown only while it matches the draft. */
export type SimpleCaseOverlay = {
  stepStatusById?: Map<string, EvalStepStatus>;
};

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
  onToolsChoiceBlockReasonChange?: (reason: string | null) => void;
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

function overlayStatus(
  overlay: SimpleCaseOverlay | null | undefined,
  stepId: string,
): EvalStepStatus | undefined {
  return overlay?.stepStatusById?.get(stepId);
}

function StatusDot({ status }: { status: EvalStepStatus | undefined }) {
  if (!status || status === "running") return null;
  const label =
    status === "ok" ? "Passed" : status === "fail" ? "Failed" : "Skipped";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
        status === "ok" && "bg-success/50 text-foreground",
        status === "fail" && "bg-destructive/50 text-destructive-foreground",
        status === "skipped" && "bg-muted text-muted-foreground",
      )}
      data-testid="simple-case-step-status"
    >
      {label}
    </span>
  );
}

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
  onToolsChoiceBlockReasonChange,
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

  const [toolsChoice, setToolsChoice] = useState<ToolsChoice>(() =>
    initialToolsChoice({ tools: view.tools, isNegativeTest }),
  );
  const [stashedTools, setStashedTools] = useState<SimpleCaseTool[]>(
    () => view.tools,
  );
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    onToolsChoiceBlockReasonChange?.(
      toolsChoice === "unset" ? UNSET_TOOLS_BLOCK_REASON : null,
    );
    return () => onToolsChoiceBlockReasonChange?.(null);
  }, [toolsChoice, onToolsChoiceBlockReasonChange]);

  useEffect(() => {
    if (view.tools.length > 0 && toolsChoice !== "tools") {
      setToolsChoice("tools");
    }
  }, [view.tools, toolsChoice]);

  const resolvedPredicates =
    resolveCasePredicates(suiteDefaultPredicates, predicates) ?? [];
  const suiteToolCalledWithApplies =
    toolsChoice === "noTool" &&
    resolvedPredicates.some((predicate) => predicate.type === "toolCalledWith");

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
  const showUnsetError = validationAttempted && toolsChoice === "unset";

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
          readOnly={readOnly}
          className={cn(
            "resize-none bg-background font-mono text-sm leading-relaxed",
            !view.prompt.trim() && evalValidationBorderClass,
          )}
        />
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
              ? "This case must take one exact route — order and no extra calls."
              : "This case should reach the right tool. Extra calls are allowed."}
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-[11px] font-medium text-foreground">
            {kind === "regression"
              ? "Which route should it take?"
              : "Which tool should handle it?"}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={toolsChoice === "noTool" ? "secondary" : "outline"}
              size="sm"
              className="h-7 text-xs"
              onClick={chooseNoTool}
              disabled={readOnly}
            >
              No tool should be called
            </Button>
            {toolsChoice === "noTool" ? (
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
          {showUnsetError ? (
            <p
              className="text-[11px] text-destructive"
              data-testid="simple-case-tools-unset"
            >
              {UNSET_TOOLS_BLOCK_REASON}
            </p>
          ) : null}
          {suiteToolCalledWithApplies ? (
            <p
              className="text-[11px] text-destructive"
              data-testid="simple-case-negative-contradiction"
            >
              This case says no tool should be called, but a toolCalledWith
              check still applies from the suite or this case. Those cannot both
              hold.
            </p>
          ) : null}

          {toolsChoice !== "noTool" ? (
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
                      {readOnly ? null : (
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
                    readOnly={readOnly}
                  />
                </div>
              ))}
              {readOnly ? null : (
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
