import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type {
  ElementLocator,
  ScriptedStep,
  StepAssertion,
} from "@/shared/scripted-steps";
import { MAX_SCRIPTED_STEPS } from "@/shared/scripted-steps";

/**
 * Authoring UI for "Widget interaction checks" — the model-free scripted steps
 * (click/type/assert) replayed against the widget a render-check turn pins.
 * Locators are authored MANUALLY in v1 (role/text/testId/css); a click-to-pick
 * helper from the live preview is a deferred fast-follow (the preview is a
 * cross-origin sandbox, so its DOM can't be scraped without an injected
 * authoring protocol).
 */

type LocatorBy = "testId" | "role" | "text" | "css";

const STEP_KIND_LABELS: Record<ScriptedStep["kind"], string> = {
  click: "Click",
  type: "Type",
  key: "Key",
  scroll: "Scroll",
  wait: "Wait",
  assert: "Assert",
};

const ASSERTION_LABELS: Record<StepAssertion["type"], string> = {
  textVisible: "Text visible",
  elementVisible: "Element visible",
  elementHidden: "Element hidden",
  inputValue: "Input value equals",
  widgetToolCalled: "Widget called tool",
};

function locatorBy(loc: ElementLocator): LocatorBy {
  if (loc.testId !== undefined) return "testId";
  if (loc.role !== undefined) return "role";
  if (loc.text !== undefined) return "text";
  return "css";
}

function emptyLocatorFor(by: LocatorBy): ElementLocator {
  switch (by) {
    case "testId":
      return { testId: "" };
    case "role":
      return { role: { role: "" } };
    case "text":
      return { text: "" };
    case "css":
      return { css: "" };
  }
}

function defaultStep(kind: ScriptedStep["kind"]): ScriptedStep {
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
    case "assert":
      return { kind: "assert", assertion: { type: "textVisible", text: "" } };
  }
}

function defaultAssertion(type: StepAssertion["type"]): StepAssertion {
  switch (type) {
    case "textVisible":
      return { type: "textVisible", text: "" };
    case "elementVisible":
      return { type: "elementVisible", target: { testId: "" } };
    case "elementHidden":
      return { type: "elementHidden", target: { testId: "" } };
    case "inputValue":
      return { type: "inputValue", target: { testId: "" }, equals: "" };
    case "widgetToolCalled":
      return { type: "widgetToolCalled", toolName: "" };
  }
}

export function LocatorFields({
  value,
  onChange,
}: {
  value: ElementLocator;
  onChange: (next: ElementLocator) => void;
}) {
  const by = locatorBy(value);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        value={by}
        onValueChange={(next) => onChange(emptyLocatorFor(next as LocatorBy))}
      >
        <SelectTrigger className="h-7 w-[92px] text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="testId">testId</SelectItem>
          <SelectItem value="role">role</SelectItem>
          <SelectItem value="text">text</SelectItem>
          <SelectItem value="css">css</SelectItem>
        </SelectContent>
      </Select>
      {by === "role" ? (
        <>
          <Input
            value={value.role?.role ?? ""}
            onChange={(e) =>
              onChange({
                role: { ...value.role, role: e.target.value },
              })
            }
            placeholder="button"
            className="h-7 w-[110px] text-[11px]"
          />
          <Input
            value={value.role?.name ?? ""}
            onChange={(e) =>
              onChange({
                role: { role: value.role?.role ?? "", name: e.target.value },
              })
            }
            placeholder='name (e.g. "Save")'
            className="h-7 flex-1 text-[11px]"
          />
        </>
      ) : (
        <Input
          value={value[by] ?? ""}
          onChange={(e) => onChange({ [by]: e.target.value })}
          placeholder={by === "css" ? ".my-button" : `${by}…`}
          className="h-7 flex-1 text-[11px]"
        />
      )}
    </div>
  );
}

function AssertionFields({
  value,
  onChange,
}: {
  value: StepAssertion;
  onChange: (next: StepAssertion) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        value={value.type}
        onValueChange={(next) =>
          onChange(defaultAssertion(next as StepAssertion["type"]))
        }
      >
        <SelectTrigger className="h-7 w-[180px] text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(ASSERTION_LABELS).map(([type, label]) => (
            <SelectItem key={type} value={type}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.type === "textVisible" ? (
        <Input
          value={value.text}
          onChange={(e) => onChange({ type: "textVisible", text: e.target.value })}
          placeholder="visible text…"
          className="h-7 text-[11px]"
        />
      ) : null}
      {value.type === "widgetToolCalled" ? (
        <Input
          value={value.toolName}
          onChange={(e) =>
            onChange({ type: "widgetToolCalled", toolName: e.target.value })
          }
          placeholder="tool name…"
          className="h-7 text-[11px]"
        />
      ) : null}
      {value.type === "elementVisible" || value.type === "elementHidden" ? (
        <LocatorFields
          value={value.target}
          onChange={(target) => onChange({ type: value.type, target })}
        />
      ) : null}
      {value.type === "inputValue" ? (
        <>
          <LocatorFields
            value={value.target}
            onChange={(target) =>
              onChange({ type: "inputValue", target, equals: value.equals })
            }
          />
          <Input
            value={value.equals}
            onChange={(e) =>
              onChange({
                type: "inputValue",
                target: value.target,
                equals: e.target.value,
              })
            }
            placeholder="equals…"
            className="h-7 text-[11px]"
          />
        </>
      ) : null}
    </div>
  );
}

function StepBody({
  step,
  onChange,
}: {
  step: ScriptedStep;
  onChange: (next: ScriptedStep) => void;
}) {
  switch (step.kind) {
    case "click":
      return (
        <div className="flex flex-col gap-1.5">
          <LocatorFields
            value={step.target}
            onChange={(target) => onChange({ ...step, target })}
          />
          <Select
            value={step.clickType ?? "left"}
            onValueChange={(next) =>
              onChange({
                ...step,
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
      );
    case "type":
      return (
        <div className="flex flex-col gap-1.5">
          <LocatorFields
            value={step.target}
            onChange={(target) => onChange({ ...step, target })}
          />
          <Input
            value={step.text}
            onChange={(e) => onChange({ ...step, text: e.target.value })}
            placeholder="text to type…"
            className="h-7 text-[11px]"
          />
        </div>
      );
    case "key":
      return (
        <Input
          value={step.key}
          onChange={(e) => onChange({ ...step, key: e.target.value })}
          placeholder="Enter, Tab, ArrowDown…"
          className="h-7 w-[180px] text-[11px]"
        />
      );
    case "scroll":
      return (
        <div className="flex items-center gap-1.5">
          <Select
            value={step.direction}
            onValueChange={(next) =>
              onChange({ ...step, direction: next as "up" | "down" })
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
            value={step.amount ?? ""}
            onChange={(e) =>
              onChange({
                ...step,
                amount: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            placeholder="amount"
            className="h-7 w-[100px] text-[11px]"
          />
        </div>
      );
    case "wait":
      return (
        <Input
          type="number"
          value={step.ms}
          onChange={(e) => onChange({ ...step, ms: Number(e.target.value) })}
          placeholder="ms"
          className="h-7 w-[120px] text-[11px]"
        />
      );
    case "assert":
      return (
        <AssertionFields
          value={step.assertion}
          onChange={(assertion) => onChange({ ...step, assertion })}
        />
      );
  }
}

/** The step list for one widget-check group. */
export function StepList({
  value,
  onChange,
}: {
  value: ScriptedStep[];
  onChange: (steps: ScriptedStep[]) => void;
}) {
  const steps = value;

  const update = (index: number, next: ScriptedStep) =>
    onChange(steps.map((s, i) => (i === index ? next : s)));
  const remove = (index: number) =>
    onChange(steps.filter((_, i) => i !== index));
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    const copy = [...steps];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    onChange(copy);
  };
  const add = () => onChange([...steps, defaultStep("click")]);

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <div
            key={index}
            className="flex gap-2 rounded-md border border-border/50 bg-muted/20 p-2"
            data-testid="scripted-step-row"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/50 bg-background text-[10px] font-medium text-muted-foreground">
              {index + 1}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Select
                value={step.kind}
                onValueChange={(next) =>
                  update(index, defaultStep(next as ScriptedStep["kind"]))
                }
              >
                <SelectTrigger className="h-7 w-[120px] text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STEP_KIND_LABELS).map(([kind, label]) => (
                    <SelectItem key={kind} value={kind}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <StepBody
                step={step}
                onChange={(next) => update(index, next)}
              />
            </div>
            <div className="flex shrink-0 flex-col gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label="Move step up"
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => move(index, 1)}
                disabled={index === steps.length - 1}
                aria-label="Move step down"
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-red-500"
                onClick={() => remove(index)}
                aria-label="Remove step"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-[11px]"
        onClick={add}
        disabled={steps.length >= MAX_SCRIPTED_STEPS}
      >
        <Plus className="mr-1 h-3 w-3" />
        Add step
      </Button>
    </div>
  );
}
