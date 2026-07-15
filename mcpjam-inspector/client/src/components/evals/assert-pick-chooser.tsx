/**
 * AssertPickChooser — the "click an element in the live widget, then say what to
 * check about it" half of record-by-clicking.
 *
 * The recorder shim already derives a stable {@link ElementLocator} from whatever
 * the user clicked inside the sandboxed widget (testId → role+name → text → css,
 * mirroring the headless harness's resolve order). In *assert* mode the editor
 * captures that locator instead of appending an interact step and opens this
 * dialog. The user picks one widget-assertion kind; we hand back a
 * {@link StepAssertion} with the locator already filled in — no manual locator
 * authoring, which is the whole point.
 *
 * We render a centered dialog rather than a popover anchored to the element:
 * the widget lives in a cross-origin iframe, so the host never learns the click's
 * screen coordinates (deriving the locator is all the shim exposes). The dialog
 * shows a human-readable description of the picked element so the user can
 * confirm they clicked the right thing.
 */
import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, FormInput, MousePointerClick, Type } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type { ElementLocator, StepAssertion } from "@/shared/scripted-steps";

/** What the editor captured on an assert-mode click. */
export type AssertPick = {
  /** Turn whose widget was clicked (host-side save gate already matched). */
  promptIndex: number;
  /** The widget tool the assertion is scoped to. */
  toolName: string;
  /** Locator the recorder derived from the clicked element. */
  locator: ElementLocator;
};

/**
 * The assertion kinds a single clicked element can seed. `widgetToolCalled` is
 * deliberately omitted: it asserts the widget invoked a *tool*, which isn't a
 * property of the element you clicked — it's authored from the step list, not by
 * pointing at the DOM.
 */
type PickKind = Exclude<StepAssertion["type"], "widgetToolCalled">;

const KIND_META: Record<
  PickKind,
  { label: string; help: string; Icon: typeof Eye; needsValue?: "text" | "equals" }
> = {
  elementVisible: {
    label: "Is visible",
    help: "Pass when this element is on screen.",
    Icon: Eye,
  },
  elementHidden: {
    label: "Is hidden",
    help: "Pass when this element is absent or not visible.",
    Icon: EyeOff,
  },
  textVisible: {
    label: "Shows text…",
    help: "Pass when the given text is visible in the widget.",
    Icon: Type,
    needsValue: "text",
  },
  inputValue: {
    label: "Input equals…",
    help: "Pass when this input's value equals the given text.",
    Icon: FormInput,
    needsValue: "equals",
  },
};

const KIND_ORDER: PickKind[] = [
  "elementVisible",
  "elementHidden",
  "textVisible",
  "inputValue",
];

/** Human-readable one-liner for a derived locator, for the confirm header. */
export function describeLocator(locator: ElementLocator): string {
  if (locator.testId) return `testId "${locator.testId}"`;
  if (locator.role) {
    const { role, name } = locator.role;
    return name ? `${role} "${name}"` : role;
  }
  if (locator.text) return `text "${locator.text}"`;
  if (locator.css) return `element ${locator.css}`;
  return "the clicked element";
}

/**
 * Build the {@link StepAssertion} for a chosen kind. `value` is the user-typed
 * text (for `textVisible`) or expected value (for `inputValue`); ignored for the
 * value-less visible/hidden kinds.
 */
export function buildStepAssertion(
  kind: PickKind,
  locator: ElementLocator,
  value: string,
): StepAssertion {
  switch (kind) {
    case "elementVisible":
      return { type: "elementVisible", target: locator };
    case "elementHidden":
      return { type: "elementHidden", target: locator };
    case "textVisible":
      return { type: "textVisible", text: value };
    case "inputValue":
      return { type: "inputValue", target: locator, equals: value };
  }
}

export function AssertPickChooser({
  pick,
  onConfirm,
  onCancel,
}: {
  /** The captured click, or null when no chooser is open. */
  pick: AssertPick | null;
  onConfirm: (assertion: StepAssertion) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<PickKind>("elementVisible");
  const [value, setValue] = useState("");

  // Reset the form each time a fresh element is picked.
  useEffect(() => {
    if (pick) {
      setKind("elementVisible");
      setValue("");
    }
  }, [pick]);

  const meta = KIND_META[kind];
  const needsValue = meta.needsValue;
  const description = useMemo(
    () => (pick ? describeLocator(pick.locator) : ""),
    [pick],
  );

  const canConfirm = !needsValue || value.trim().length > 0;

  const confirm = () => {
    if (!pick || !canConfirm) return;
    onConfirm(buildStepAssertion(kind, pick.locator, value.trim()));
  };

  return (
    <Dialog
      open={pick !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MousePointerClick className="h-4 w-4 text-amber-500" />
            What should we check?
          </DialogTitle>
          <DialogDescription>
            You picked <span className="font-medium text-foreground">{description}</span>
            . Choose what this step should assert.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-1">
          {KIND_ORDER.map((k) => {
            const m = KIND_META[k];
            const active = k === kind;
            const { Icon } = m;
            return (
              <button
                key={k}
                type="button"
                data-testid={`assert-pick-${k}`}
                aria-pressed={active}
                onClick={() => setKind(k)}
                className={
                  "flex flex-col gap-1 rounded-lg border p-3 text-left transition " +
                  (active
                    ? "border-amber-500/60 bg-amber-500/5 ring-1 ring-amber-500/30"
                    : "border-border/60 hover:border-border hover:bg-muted/30")
                }
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {m.label}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {m.help}
                </span>
              </button>
            );
          })}
        </div>

        {needsValue ? (
          <div className="space-y-1.5">
            <Label htmlFor="assert-pick-value" className="text-[12px]">
              {needsValue === "text" ? "Text to look for" : "Expected value"}
            </Label>
            <Input
              id="assert-pick-value"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder={
                needsValue === "text" ? "e.g. Added to cart" : "e.g. 2"
              }
              className="h-8 text-sm"
            />
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canConfirm}
            data-testid="assert-pick-confirm"
            onClick={confirm}
          >
            Add check
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
