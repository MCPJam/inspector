/**
 * Per-kind step field editors, shared by the two surfaces that author steps.
 *
 * These were private to `StepListEditor` — the deep step list on `/evals`. The
 * spine on the Evaluate surface authors the SAME four step kinds, and a second
 * copy of an interact-action editor or a widget-assertion editor is how two
 * surfaces start disagreeing about what a step can hold. Moved verbatim: the
 * markup, the test ids and the field semantics are unchanged, and
 * `StepListEditor` now imports them.
 */

import {
  CheckCircle2,
  Gavel,
  Loader2,
  MessageSquare,
  MinusCircle,
  MousePointerClick,
  Wrench,
  XCircle,
} from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { ElementLocator } from "@/shared/scripted-steps";
import {
  isWidgetAssertion,
  newStepId,
  WIDGET_ASSERTION_LABELS,
  type InteractAction,
  type TestStep,
  type WidgetAssertion,
} from "@/shared/steps";
import { blankPredicate } from "./checks-section";
import { LocatorFields } from "./scripted-steps-editor";

export type AvailableTool = {
  name: string;
  description?: string;
  inputSchema?: any;
  serverId?: string;
  /** "system" = harness-native built-in (bash, read, …). Assertable by name,
   *  but not invokable through MCPJam and never a widget view — the pinned
   *  tool-call and "View (tool)" pickers filter these back out. */
  source?: "system";
};

/** Tools MCPJam can actually invoke / render as a widget view — everything
 *  except harness system tools. */
export function invokableTools(tools: AvailableTool[]): AvailableTool[] {
  return tools.filter((t) => t.source !== "system");
}

// ── per-kind labels / icons ───────────────────────────────────────────────────
export const STEP_META: Record<
  TestStep["kind"],
  { label: string; Icon: typeof MessageSquare; tint: string }
> = {
  prompt: {
    label: "Prompt",
    Icon: MessageSquare,
    tint: "text-sky-600 dark:text-sky-400",
  },
  toolCall: {
    label: "Tool call",
    Icon: Wrench,
    tint: "text-violet-600 dark:text-violet-400",
  },
  interact: {
    label: "Interact",
    Icon: MousePointerClick,
    tint: "text-amber-600 dark:text-amber-400",
  },
  assert: {
    // A neutral "ruling" icon — NOT a green check. The check shape + emerald
    // tint read as "passed", so a failing assertion looked passed regardless of
    // its verdict. Verdict is carried by `StepStatusBadge` (✓/✗) instead; the
    // type icon must stay verdict-neutral.
    label: "Assertion",
    Icon: Gavel,
    tint: "text-indigo-600 dark:text-indigo-400",
  },
};

/** Live status pip shown in a step card header during a quick run. */
export function StepStatusBadge({ status }: { status: EvalStepStatus }) {
  if (status === "running") {
    return (
      <Loader2
        className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-label="Step running"
      />
    );
  }
  if (status === "ok") {
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-label="Step passed"
      />
    );
  }
  if (status === "skipped") {
    // Fail-fast never ran this step — greyed, distinct from fail (red).
    return (
      <MinusCircle
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
        aria-label="Step skipped"
      />
    );
  }
  return (
    <XCircle
      className="h-3.5 w-3.5 shrink-0 text-destructive"
      aria-label="Step failed"
    />
  );
}

export function summarizeStep(step: TestStep): string {
  switch (step.kind) {
    case "prompt": {
      const t = step.prompt.trim();
      if (!t) return "Empty prompt";
      return t.length > 72 ? `${t.slice(0, 72)}…` : t;
    }
    case "toolCall":
      return `${step.toolName || "pick a tool"}${
        step.serverName ? ` on ${step.serverName}` : ""
      }`;
    case "interact":
      return `${step.action.kind} · ${step.toolName || "view"}`;
    case "assert": {
      const a = step.assertion;
      if (isWidgetAssertion(a)) return `${a.kind} · ${a.toolName}`;
      if (a.type === "toolCalledWith") return `tool called: ${a.toolName}`;
      return a.type;
    }
    default:
      return "";
  }
}

// ── interact action sub-editor ────────────────────────────────────────────────
export const INTERACT_ACTION_KINDS = [
  "click",
  "type",
  "key",
  "scroll",
  "wait",
] as const;

export function defaultInteractAction(
  kind: InteractAction["kind"],
): InteractAction {
  switch (kind) {
    case "click":
      return { kind: "click", target: { testId: "" } };
    case "type":
      return { kind: "type", target: { testId: "" }, text: "" };
    case "key":
      return { kind: "key", key: "" };
    case "scroll":
      return { kind: "scroll", direction: "down" };
    case "wait":
      return { kind: "wait", ms: 500 };
  }
}

export function InteractActionFields({
  value,
  onChange,
  readOnly = false,
}: {
  value: InteractAction;
  onChange: (next: InteractAction) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        value={value.kind}
        onValueChange={(next) =>
          onChange(defaultInteractAction(next as InteractAction["kind"]))
        }
      >
        <SelectTrigger className="h-7 w-[120px] text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {INTERACT_ACTION_KINDS.map((k) => (
            <SelectItem key={k} value={k} className="text-[11px]">
              {k}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.kind === "click" ? (
        <div className="flex flex-col gap-1.5">
          <LocatorFields
            value={value.target}
            onChange={(target) => onChange({ ...value, target })}
            readOnly={readOnly}
          />
          <Select
            value={value.clickType ?? "left"}
            onValueChange={(next) =>
              onChange({
                ...value,
                clickType: next as "left" | "double" | "right",
              })
            }
          >
            <SelectTrigger className="h-7 w-[120px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="left">left</SelectItem>
              <SelectItem value="double">double</SelectItem>
              <SelectItem value="right">right</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {value.kind === "type" ? (
        <div className="flex flex-col gap-1.5">
          <LocatorFields
            value={value.target}
            onChange={(target) => onChange({ ...value, target })}
            readOnly={readOnly}
          />
          <Input
            value={value.text}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
            placeholder="text to type…"
            className="h-7 text-[11px]"
          />
        </div>
      ) : null}
      {value.kind === "key" ? (
        <Input
          value={value.key}
          onChange={(e) => onChange({ ...value, key: e.target.value })}
          placeholder="Enter, Tab, ArrowDown…"
          className="h-7 w-[180px] text-[11px]"
        />
      ) : null}
      {value.kind === "scroll" ? (
        <div className="flex items-center gap-1.5">
          <Select
            value={value.direction}
            onValueChange={(next) =>
              onChange({ ...value, direction: next as "up" | "down" })
            }
          >
            <SelectTrigger className="h-7 w-[92px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="down">down</SelectItem>
              <SelectItem value="up">up</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            value={value.amount ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                amount: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            placeholder="amount"
            className="h-7 w-[100px] text-[11px]"
          />
        </div>
      ) : null}
      {value.kind === "wait" ? (
        <Input
          type="number"
          value={value.ms}
          onChange={(e) => onChange({ ...value, ms: Number(e.target.value) })}
          placeholder="ms"
          className="h-7 w-[120px] text-[11px]"
        />
      ) : null}
    </div>
  );
}

// ── widget assertion sub-editor ───────────────────────────────────────────────
export const WIDGET_ASSERTION_KINDS: ReadonlyArray<WidgetAssertion["kind"]> = [
  "textVisible",
  "elementVisible",
  "elementHidden",
  "inputValue",
  "widgetToolCalled",
];

export function defaultWidgetAssertion(
  kind: WidgetAssertion["kind"],
  toolName: string,
): WidgetAssertion {
  switch (kind) {
    case "textVisible":
      return { kind, toolName, text: "" };
    case "elementVisible":
    case "elementHidden":
      return { kind, toolName, target: { testId: "" } };
    case "inputValue":
      return { kind, toolName, target: { testId: "" }, equals: "" };
    case "widgetToolCalled":
      return { kind, toolName, calledToolName: "" };
  }
}

export function WidgetAssertionFields({
  value,
  onChange,
  availableTools,
  readOnly = false,
}: {
  value: WidgetAssertion;
  onChange: (next: WidgetAssertion) => void;
  availableTools: AvailableTool[];
  readOnly?: boolean;
}) {
  const target =
    "target" in value ? (value.target as ElementLocator) : undefined;
  const viewTools = invokableTools(availableTools);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">View (tool)</Label>
          {viewTools.length > 0 ? (
            <Select
              value={value.toolName || undefined}
              onValueChange={(next) => onChange({ ...value, toolName: next })}
            >
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue placeholder="Pick a view tool…" />
              </SelectTrigger>
              <SelectContent>
                {Array.from(new Set(viewTools.map((t) => t.name))).map(
                  (name) => (
                    <SelectItem key={name} value={name} className="text-[11px]">
                      {name}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={value.toolName}
              onChange={(e) => onChange({ ...value, toolName: e.target.value })}
              placeholder="view tool name…"
              className="h-7 text-[11px]"
            />
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Assertion</Label>
          <Select
            value={value.kind}
            onValueChange={(next) =>
              onChange(
                defaultWidgetAssertion(
                  next as WidgetAssertion["kind"],
                  value.toolName,
                ),
              )
            }
          >
            <SelectTrigger className="h-7 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WIDGET_ASSERTION_KINDS.map((k) => (
                <SelectItem key={k} value={k} className="text-[11px]">
                  {WIDGET_ASSERTION_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {value.kind === "textVisible" ? (
        <Input
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          placeholder="visible text…"
          className="h-7 text-[11px]"
        />
      ) : null}
      {value.kind === "widgetToolCalled" ? (
        <Input
          value={value.calledToolName}
          onChange={(e) =>
            onChange({ ...value, calledToolName: e.target.value })
          }
          placeholder="called tool name…"
          className="h-7 text-[11px]"
        />
      ) : null}
      {target !== undefined &&
      (value.kind === "elementVisible" ||
        value.kind === "elementHidden" ||
        value.kind === "inputValue") ? (
        <LocatorFields
          value={target}
          onChange={(nextTarget) =>
            onChange({ ...value, target: nextTarget } as WidgetAssertion)
          }
          readOnly={readOnly}
        />
      ) : null}
      {value.kind === "inputValue" ? (
        <Input
          value={value.equals}
          onChange={(e) => onChange({ ...value, equals: e.target.value })}
          placeholder="equals…"
          className="h-7 text-[11px]"
        />
      ) : null}
    </div>
  );
}

// ── add-step / add-assertion factories ────────────────────────────────────────
export function blankStepOfKind(
  kind: TestStep["kind"],
  suiteServers: string[],
): TestStep {
  switch (kind) {
    case "prompt":
      return { id: newStepId("prompt"), kind: "prompt", prompt: "" };
    case "toolCall":
      return {
        id: newStepId("call"),
        kind: "toolCall",
        serverName: suiteServers[0] ?? "",
        toolName: "",
        arguments: {},
      };
    case "interact":
      return {
        id: newStepId("interact"),
        kind: "interact",
        toolName: "",
        action: { kind: "click", target: { testId: "" } },
      };
    case "assert":
      return {
        id: newStepId("assert"),
        kind: "assert",
        assertion: blankPredicate("toolCalledWith"),
      };
  }
}
