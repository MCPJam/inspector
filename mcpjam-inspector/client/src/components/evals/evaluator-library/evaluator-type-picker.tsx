import { Check, ListChecks, ListTodo, Scale } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { EvaluatorMethod } from "./evaluator-library-types";

/** List built-in assertions before methods that require a model. */
const METHODS = [
  {
    value: "assertions",
    title: "Assertions",
    description: "Combine built-in checks. Same result every time, no model.",
    icon: ListChecks,
    tone: "bg-info/10 text-info",
  },
  {
    value: "judge",
    title: "Judge prompt",
    description:
      "Write your own grading prompt. A model reads the iteration and grades it.",
    icon: Scale,
    tone: "bg-primary/10 text-primary",
  },
  {
    value: "decision",
    title: "Decision questions",
    description:
      "Ask typed questions a small classifier answers. Cheaper and steadier than a judge.",
    icon: ListTodo,
    tone: "bg-success/10 text-success",
  },
] as const satisfies readonly {
  value: EvaluatorMethod;
  title: string;
  description: string;
  icon: typeof Check;
  tone: string;
}[];

export type EvaluatorTypePickerProps = {
  value: EvaluatorMethod | null;
  onChange: (value: EvaluatorMethod) => void;
};

/**
 * The first step of New evaluator. Server checks are deliberately absent:
 * they grade the server once per deploy, not a run, so they are not evaluators.
 */
export function EvaluatorTypePicker({
  value,
  onChange,
}: EvaluatorTypePickerProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = METHODS.findIndex((m) => m.value === value);

  function onKeyDown(event: KeyboardEvent, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + METHODS.length) % METHODS.length;
    onChange(METHODS[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="How should this evaluator decide?"
      className="grid gap-3 sm:grid-cols-3"
    >
      {METHODS.map((method, index) => {
        const checked = method.value === value;
        const Icon = method.icon;
        return (
          <button
            key={method.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (selectedIndex < 0 && index === 0) ? 0 : -1}
            onClick={() => onChange(method.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "flex flex-col gap-2 rounded-lg border border-border bg-popover p-4 text-left outline-none transition-[border-color,box-shadow]",
              "hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/50",
              checked && "border-primary ring-[3px] ring-primary/15",
            )}
          >
            <span className="flex items-center">
              <span
                aria-hidden
                className={cn(
                  "grid size-8 place-items-center rounded-md",
                  method.tone,
                )}
              >
                <Icon className="size-4" />
              </span>
              {checked ? (
                <span
                  aria-hidden
                  className="ml-auto grid size-4 place-items-center rounded-sm bg-primary text-primary-foreground"
                >
                  <Check className="size-3" />
                </span>
              ) : null}
            </span>
            <span className="text-sm font-semibold text-card-foreground">
              {method.title}
            </span>
            <span className="text-sm text-muted-foreground">
              {method.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
