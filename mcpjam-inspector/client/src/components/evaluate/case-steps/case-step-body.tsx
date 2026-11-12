/**
 * What sits inside a step's card: the prompt box or the action card, and the
 * fields an open assertion row shows. Every field editor is the product's own.
 */
import { ChevronDown, MousePointerClick, Wrench } from "lucide-react";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import type { RemoteServer } from "@/hooks/useProjects";
import { CheckRow } from "@/components/evals/checks-section";
import { PinnedToolCallFields } from "@/components/evals/pinned-tool-call-fields";
import {
  InteractActionFields,
  invokableTools,
  WidgetAssertionFields,
  type AvailableTool,
} from "@/components/evals/step-fields";
import {
  isWidgetAssertion,
  type AssertStep,
  type InteractStep,
  type SpineAction,
  type TestStep,
  type ToolCallStep,
} from "@/shared/steps";
import { interactText, STEP_COPY } from "./case-steps-model";
import { RoleControl } from "./case-step-parts";

const NO_STEP = "__before_first_step__";

export function PromptBox({
  step,
  first,
  readOnly,
  onChange,
}: {
  step: Extract<TestStep, { kind: "prompt" }>;
  first: boolean;
  readOnly: boolean;
  onChange: (next: TestStep) => void;
}) {
  return (
    <Textarea
      aria-label={first ? "What does the user ask?" : "Follow-up prompt"}
      value={step.prompt}
      rows={2}
      readOnly={readOnly}
      placeholder="Enter the user prompt…"
      onChange={(event) => onChange({ ...step, prompt: event.target.value })}
      className="min-h-[72px] resize-y rounded-lg border-input bg-card px-3.5 py-3 font-mono text-sm leading-[22px] text-card-foreground md:text-sm"
    />
  );
}

function actionLine(step: InteractStep | ToolCallStep) {
  if (step.kind === "toolCall") {
    const tool = step.toolName.trim();
    return tool
      ? { value: tool, extra: `on ${step.serverName}` }
      : { missing: "Pick a tool" };
  }
  const view = step.toolName.trim();
  if (!view) return { missing: "Pick a view" };
  const text = interactText(step.action);
  return text
    ? { value: text, extra: `in ${view}` }
    : { missing: "Pick a target", extra: `in ${view}` };
}

function ViewToolSelect({
  step,
  availableTools,
  readOnly,
  onChange,
}: {
  step: InteractStep;
  availableTools: AvailableTool[];
  readOnly: boolean;
  onChange: (next: TestStep) => void;
}) {
  const names = [
    ...new Set(invokableTools(availableTools).map((tool) => tool.name)),
  ];
  if (step.toolName && !names.includes(step.toolName))
    names.unshift(step.toolName);
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">View (tool)</Label>
      <Select
        value={step.toolName || undefined}
        disabled={readOnly}
        onValueChange={(toolName) => onChange({ ...step, toolName })}
      >
        <SelectTrigger
          aria-label="View tool"
          aria-invalid={!readOnly && !step.toolName.trim()}
          className="h-9 w-full text-sm font-normal"
        >
          <SelectValue placeholder="Pick a view tool…" />
        </SelectTrigger>
        <SelectContent>
          {names.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ActionCard({
  step,
  open,
  onToggle,
  readOnly,
  availableTools,
  suiteServers,
  projectServers,
  onChange,
}: {
  step: InteractStep | ToolCallStep;
  open: boolean;
  onToggle: () => void;
  readOnly: boolean;
  availableTools: AvailableTool[];
  suiteServers: string[];
  projectServers?: RemoteServer[];
  onChange: (next: TestStep) => void;
}) {
  const line = actionLine(step);
  const Icon = step.kind === "interact" ? MousePointerClick : Wrench;
  return (
    <div
      className={cn(
        "rounded-lg border bg-card",
        open ? "border-ring/60" : "border-border",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        data-case-step-toggle={`action:${step.id}`}
        onClick={onToggle}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left"
      >
        <Icon className="size-4 shrink-0 text-info" aria-hidden />
        {line.value ? (
          <code className="max-w-full truncate rounded-md border border-border bg-muted/60 px-1.5 py-px font-mono text-xs leading-5 text-card-foreground">
            {line.value}
          </code>
        ) : (
          <span className="text-xs text-destructive">{line.missing}</span>
        )}
        {line.extra ? (
          <span className="text-xs text-muted-foreground">{line.extra}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          {open ? "Done" : "Edit"}
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </button>
      {open ? (
        <fieldset
          disabled={readOnly}
          className="min-w-0 space-y-2 border-t border-border px-3 py-3 sm:px-4"
        >
          {step.kind === "interact" ? (
            <>
              <ViewToolSelect
                step={step}
                availableTools={availableTools}
                readOnly={readOnly}
                onChange={onChange}
              />
              <InteractActionFields
                paper
                value={step.action}
                readOnly={readOnly}
                onChange={(action) => onChange({ ...step, action })}
              />
            </>
          ) : (
            <PinnedToolCallFields
              paper
              seedKey={step.id}
              value={{
                ...(step.serverId ? { serverId: step.serverId } : {}),
                serverName: step.serverName,
                toolName: step.toolName,
                arguments: step.arguments,
                ...(step.renderTimeoutMs
                  ? { renderTimeoutMs: step.renderTimeoutMs }
                  : {}),
              }}
              suiteServers={suiteServers}
              projectServers={projectServers}
              availableTools={invokableTools(availableTools)}
              readOnly={readOnly}
              onChange={(cfg) =>
                onChange({
                  ...step,
                  serverId:
                    cfg.serverId ??
                    (cfg.serverName === step.serverName
                      ? step.serverId
                      : undefined),
                  serverName: cfg.serverName,
                  toolName: cfg.toolName,
                  arguments: cfg.arguments,
                  renderTimeoutMs: cfg.renderTimeoutMs,
                })
              }
            />
          )}
        </fieldset>
      ) : null}
    </div>
  );
}

/** The open body of an assertion row: where it is graded, its role, then its fields. */
export function AssertionEditor({
  step,
  actionId,
  actions,
  availableTools,
  readOnly,
  onChange,
  onMove,
}: {
  step: AssertStep;
  /** The step it follows; null before the first step. */
  actionId: string | null;
  actions: SpineAction[];
  availableTools: AvailableTool[];
  readOnly: boolean;
  onChange: (next: AssertStep) => void;
  onMove: (actionId: string | null) => void;
}) {
  const assertion = step.assertion;
  const widget = isWidgetAssertion(assertion);
  const toolNames = availableTools.map((tool) => tool.name);
  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-48 space-y-1">
          <Label className="text-xs font-medium text-muted-foreground">
            Graded after
          </Label>
          <Select
            value={actionId ?? undefined}
            disabled={readOnly}
            onValueChange={(id) => onMove(id === NO_STEP ? null : id)}
          >
            <SelectTrigger
              aria-label="Graded after"
              className="h-9 w-full text-sm font-normal"
            >
              <SelectValue placeholder="Before the first step" />
            </SelectTrigger>
            <SelectContent>
              {actions.map((action) => (
                <SelectItem
                  key={action.step.id}
                  value={action.step.id}
                  className="text-sm"
                >
                  {`Step ${action.ordinal} · ${STEP_COPY[action.step.kind as keyof typeof STEP_COPY].title}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {widget ? null : (
          <RoleControl
            predicate={assertion}
            readOnly={readOnly}
            onChange={(next) => onChange({ ...step, assertion: next })}
          />
        )}
      </div>
      {widget ? (
        <>
          <p className="text-xs text-muted-foreground">
            Checked against the live view at this point. Always blocking.
          </p>
          <WidgetAssertionFields
            paper
            value={assertion}
            availableTools={availableTools}
            readOnly={readOnly}
            onChange={(next) => onChange({ ...step, assertion: next })}
          />
        </>
      ) : assertion.type === "noToolErrors" ? (
        <p className="text-[13px] text-card-foreground">
          Passes when no tool reports an error.
        </p>
      ) : (
        <CheckRow
          noun="assertion"
          embedded
          paper
          predicate={assertion}
          availableTools={toolNames}
          toolArgSchemas={Object.fromEntries(
            availableTools.map((tool) => [
              tool.name,
              tool.inputSchema?.properties ?? {},
            ]),
          )}
          readOnly={readOnly}
          onChange={(next) => onChange({ ...step, assertion: next })}
        />
      )}
    </fieldset>
  );
}
