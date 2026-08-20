/**
 * Numbered progress stepper for multi-step flows.
 *
 * Shared rather than inlined in the Swarm create flow (BB-124): Swarm's four
 * steps are the first user, but the shape — numbered pill, label, connector,
 * one current step — is the same wherever a flow needs to say "you are here".
 *
 * PURE PRESENTATION. It derives each step's state from `activeIndex` and owns
 * no routing: the caller decides which earlier steps are safe to return to.
 * That split matters because "already visited" is not the same as "safe to
 * revisit" — Swarm can't rewind past a launch without re-running it.
 *
 * `Done` is deliberately not a step. A flow's terminal state is a state of the
 * last step, not a fifth circle that can never be current.
 */

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProgressStepperStep = {
  /** Stable key. Also the value handed to `onStepSelect`'s caller via index. */
  id: string;
  label: string;
};

export type ProgressStepperState = "complete" | "current" | "upcoming";

/** Everything before `activeIndex` is done; everything after is still ahead. */
export function progressStepperState(
  index: number,
  activeIndex: number
): ProgressStepperState {
  if (index < activeIndex) return "complete";
  if (index === activeIndex) return "current";
  return "upcoming";
}

export function ProgressStepper({
  steps,
  activeIndex,
  onStepSelect,
  isStepSelectable,
  ariaLabel = "Progress",
  className,
  testId,
}: {
  steps: readonly ProgressStepperStep[];
  /** Index of the step the user is on. */
  activeIndex: number;
  /**
   * Called with the index of a step the user picked. Steps are inert unless
   * this is provided AND `isStepSelectable` returns true for them — a stepper
   * with no handler is a read-only progress indicator, not broken navigation.
   */
  onStepSelect?: (index: number) => void;
  /** Defaults to "any completed step" when `onStepSelect` is given. */
  isStepSelectable?: (index: number) => boolean;
  ariaLabel?: string;
  className?: string;
  testId?: string;
}) {
  const selectable = (index: number, state: ProgressStepperState) => {
    if (!onStepSelect) return false;
    if (isStepSelectable) return isStepSelectable(index);
    return state === "complete";
  };

  return (
    <ol
      aria-label={ariaLabel}
      className={cn("flex min-w-0 items-center gap-3", className)}
      data-testid={testId}
    >
      {steps.map((step, index) => {
        const state = progressStepperState(index, activeIndex);
        const canSelect = selectable(index, state);
        const isLast = index === steps.length - 1;

        return (
          <li
            key={step.id}
            // `contents` keeps the connector a sibling of the pills in the
            // parent flex row: nested in the <li>, `grow` would measure against
            // the item instead of the whole rail and the lines would not
            // divide the leftover width evenly.
            className="contents"
            aria-current={state === "current" ? "step" : undefined}
          >
            <StepMarker
              step={step}
              index={index}
              state={state}
              canSelect={canSelect}
              onSelect={onStepSelect}
            />
            {isLast ? null : (
              <span
                aria-hidden
                className={cn(
                  "h-0.5 min-w-4 grow rounded-full",
                  state === "complete" ? "bg-primary/40" : "bg-border"
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepMarker({
  step,
  index,
  state,
  canSelect,
  onSelect,
}: {
  step: ProgressStepperStep;
  index: number;
  state: ProgressStepperState;
  canSelect: boolean;
  onSelect?: (index: number) => void;
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "flex size-5.5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold leading-none",
          state === "current"
            ? "bg-primary text-primary-foreground"
            : state === "complete"
              ? "bg-primary/15 text-primary"
              : "bg-muted font-medium text-muted-foreground"
        )}
      >
        {state === "complete" ? (
          <Check className="size-3" strokeWidth={3} />
        ) : (
          index + 1
        )}
      </span>
      <span
        className={cn(
          "shrink-0 truncate text-sm",
          state === "current"
            ? "font-semibold text-primary"
            : state === "complete"
              ? "font-medium text-foreground"
              : "text-muted-foreground"
        )}
      >
        {step.label}
      </span>
    </>
  );

  const shared = "flex shrink-0 items-center gap-2";

  if (!canSelect) {
    // A <span>, not a disabled <button>: an upcoming step is not a control the
    // user could use if only something changed — it is a label.
    return <span className={shared}>{body}</span>;
  }

  return (
    <button
      type="button"
      onClick={() => onSelect?.(index)}
      // The visible label already names the destination; the prefix is what
      // turns it into an action for a screen reader hitting it out of context.
      aria-label={`Back to ${step.label}`}
      className={cn(
        shared,
        "rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
    >
      {body}
    </button>
  );
}
