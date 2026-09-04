import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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
import { ChecksSection, ToolCalledWithFields } from "../checks-section";
import {
  deriveCaseKind,
  initialToolsChoice,
  matchOptionsForKind,
  readSimpleCase,
  UNSET_TOOLS_BLOCK_REASON,
  writeSimpleCase,
  type CaseKind,
  type SimpleCaseTool,
  type ToolsChoice,
} from "./simple-case-model";

const MORE_CHECK_GROUPS: Array<{
  id: "response" | "selection" | "call" | "appView";
  label: string;
  kinds: ReadonlyArray<Predicate["type"]>;
}> = [
  {
    id: "response",
    label: "Response",
    kinds: [
      "responseContains",
      "responseMatches",
      "finalAssistantMessageNonEmpty",
      "noToolErrors",
      "tokenBudgetUnder",
      "turnCountUnder",
    ],
  },
  {
    id: "selection",
    label: "Selection",
    kinds: [
      "toolCalledWith",
      "toolCalledAtLeastOnce",
      "toolNeverCalled",
      "firstToolWas",
    ],
  },
  {
    id: "call",
    label: "Call",
    kinds: [],
  },
  {
    id: "appView",
    label: "App view",
    kinds: [
      "widgetRendered",
      "widgetRenderLatencyUnder",
      "widgetNoConsoleErrors",
    ],
  },
];

export type SimpleCaseFormProps = {
  steps: TestStep[];
  onStepsChange: (next: TestStep[]) => void;
  matchOptions?: EvalMatchOptions;
  onMatchOptionsChange: (next: EvalMatchOptions) => void;
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
};

export function SimpleCaseForm({
  steps,
  onStepsChange,
  matchOptions,
  onMatchOptionsChange,
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
}: SimpleCaseFormProps) {
  const view = useMemo(() => readSimpleCase(steps), [steps]);
  const resolvedMatch = resolveMatchOptions(
    suiteDefaultMatchOptions,
    matchOptions,
  );
  const kind = deriveCaseKind(resolvedMatch);

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

  // Adopt / Generate / deep-editor writes can add tools while this form
  // is mounted. Flip off "unset" so Save/Run unblock without a second click.
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
    onMatchOptionsChange(matchOptionsForKind(next));
  };

  const setPrompt = (prompt: string) => {
    onStepsChange(
      writeSimpleCase(steps, {
        prompt,
        tools: view.tools,
        noTool: toolsChoice === "noTool",
      }),
    );
  };

  const setTools = (tools: SimpleCaseTool[]) => {
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
    const name = toolName.trim();
    if (!name) return;
    setToolsChoice("tools");
    setTools([
      ...view.tools,
      { id: `assert-${Date.now()}-${view.tools.length + 1}`, toolName: name, arguments: {} },
    ]);
  };

  const caseList = predicates?.list ?? [];
  const setCaseList = (list: Predicate[]) => {
    onPredicatesChange(list.length === 0 ? undefined : { mode: "extend", list });
  };

  const predicatesByGroup = (kinds: ReadonlyArray<Predicate["type"]>) =>
    caseList.filter((predicate) => kinds.includes(predicate.type));

  return (
    <div className="space-y-6" data-testid="simple-case-form">
      <div className="flex items-start justify-between gap-3">
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
          <ToggleGroupItem value="capability" className="h-7 px-2.5 text-xs">
            Capability
          </ToggleGroupItem>
          <ToggleGroupItem value="regression" className="h-7 px-2.5 text-xs">
            Regression
          </ToggleGroupItem>
        </ToggleGroup>
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
      <p className="text-[11px] leading-snug text-muted-foreground">
        {kind === "regression"
          ? "This case must take one exact route — order and no extra calls."
          : "This case should reach the right tool. Extra calls are allowed."}
      </p>

      <section className="space-y-2">
        <Label className="text-[11px] font-medium text-foreground">
          What does the user ask?
        </Label>
        <Textarea
          value={view.prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          placeholder="Enter the user prompt…"
          autoFocus={autoFocusPrompt}
          aria-label="What does the user ask?"
          className={cn(
            "resize-none bg-background font-mono text-sm leading-relaxed",
            !view.prompt.trim() && evalValidationBorderClass,
          )}
        />
      </section>

      <section className="space-y-2">
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
            >
              Use tools instead
            </Button>
          ) : null}
        </div>
        {toolsChoice === "unset" ? (
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
            This case says no tool should be called, but a toolCalledWith check
            still applies from the suite or this case. Those cannot both hold.
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground"
                    aria-label={`Remove ${tool.toolName || "tool"}`}
                    onClick={() =>
                      setTools(view.tools.filter((row) => row.id !== tool.id))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {kind === "regression" ? (
                  <ToolCalledWithFields
                    predicate={{
                      type: "toolCalledWith",
                      toolName: tool.toolName,
                      args: { args: tool.arguments },
                    }}
                    onChange={(next) => {
                      if (next.type !== "toolCalledWith") return;
                      setTools(
                        view.tools.map((row) =>
                          row.id === tool.id
                            ? {
                                ...row,
                                toolName: next.toolName,
                                arguments: next.args.args ?? {},
                              }
                            : row,
                        ),
                      );
                    }}
                    availableTools={availableTools}
                    readOnly={false}
                  />
                ) : (
                  <ToolCalledWithFields
                    predicate={{
                      type: "toolCalledWith",
                      toolName: tool.toolName,
                      args: { args: {} },
                    }}
                    onChange={(next) => {
                      if (next.type !== "toolCalledWith") return;
                      setTools(
                        view.tools.map((row) =>
                          row.id === tool.id
                            ? { ...row, toolName: next.toolName, arguments: {} }
                            : row,
                        ),
                      );
                    }}
                    availableTools={availableTools}
                    readOnly={false}
                  />
                )}
              </div>
            ))}
            <AddToolRow
              availableTools={availableTools}
              onAdd={addTool}
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
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
        />
        <p className="text-[11px] text-muted-foreground">
          Model grader · advisory. Setting this changes what the judge grades
          against.
        </p>
      </section>

      <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-0 text-xs text-muted-foreground"
          >
            More checks
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
                {group.kinds.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    Argument matching stays partial for both kinds. Nothing else
                    is authorable at call today.
                  </p>
                ) : (
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
                  />
                )}
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
