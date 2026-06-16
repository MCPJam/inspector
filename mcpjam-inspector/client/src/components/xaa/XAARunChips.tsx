import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  getXAAPhaseNumber,
  getXAAStepIndex,
  getXAAStepInfo,
  XAA_STEP_ORDER,
} from "@/lib/xaa/step-metadata";
import type { XAAFlowState, XAAFlowStep } from "@/lib/xaa/types";

// "idle" and "complete" are machine states, not work the run performs.
const CHIP_STEPS: XAAFlowStep[] = XAA_STEP_ORDER.filter(
  (step) => step !== "idle" && step !== "complete"
);

// "phase.index" labels for each step (e.g. "2.1"), so a segment reads as a
// place in the flow rather than an anonymous tick.
const STEP_NUMBERS: Partial<Record<XAAFlowStep, string>> = (() => {
  const labels: Partial<Record<XAAFlowStep, string>> = {};
  const perPhase = new Map<number, number>();
  for (const step of CHIP_STEPS) {
    const phase = getXAAStepInfo(step).phase;
    const phaseNumber = phase ? getXAAPhaseNumber(phase) : 0;
    const next = (perPhase.get(phaseNumber) ?? 0) + 1;
    perPhase.set(phaseNumber, next);
    labels[step] = `${phaseNumber}.${next}`;
  }
  return labels;
})();

type ChipStatus = "pass" | "fail" | "untouched";

export function chipStatusFor(
  step: XAAFlowStep,
  flowState: Pick<XAAFlowState, "currentStep" | "error" | "negativeProbe">
): ChipStatus {
  const stepIndex = getXAAStepIndex(step);
  const currentIndex = getXAAStepIndex(flowState.currentStep);

  if (flowState.error && step === flowState.currentStep) {
    return "fail";
  }
  // A negative-mode run ends at the step it reached: a rejection is the pass
  // condition (green), an accepted broken assertion is the failure (red).
  if (flowState.negativeProbe && step === flowState.currentStep) {
    return flowState.negativeProbe.outcome === "rejected" ? "pass" : "fail";
  }
  if (stepIndex < currentIndex || flowState.currentStep === "complete") {
    return "pass";
  }
  // The step the flow sits on without an error hasn't finished yet.
  return "untouched";
}

/**
 * Run-progress rail. Each step is a labelled segment coloured by outcome
 * (pass / fail / pending). Steps that have run can be clicked to focus that
 * step in the diagram and logger; hovering any segment shows its section name
 * so the numbers aren't cryptic.
 */
export function XAARunChips({
  flowState,
  activeStep,
  onFocusStep,
}: {
  flowState: Pick<
    XAAFlowState,
    "currentStep" | "error" | "isBusy" | "negativeProbe"
  >;
  activeStep?: XAAFlowStep | null;
  onFocusStep?: (step: XAAFlowStep) => void;
}) {
  const [hoveredStep, setHoveredStep] = useState<XAAFlowStep | null>(null);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <ol
        aria-label="Run progress"
        className="flex flex-wrap items-center gap-1"
      >
        {CHIP_STEPS.map((step) => {
          const status = chipStatusFor(step, flowState);
          const info = getXAAStepInfo(step);
          const isCurrent =
            step === flowState.currentStep &&
            flowState.currentStep !== "complete";
          const isFocused = activeStep === step;
          // Only steps the run has actually reached have something to navigate
          // to, so untouched steps stay inert until the flow gets there.
          const hasRun = status === "pass" || status === "fail" || isCurrent;
          const interactive = Boolean(onFocusStep) && hasRun;

          return (
            <li key={step} className="shrink-0">
              <button
                type="button"
                data-testid={`xaa-run-chip-${step}`}
                data-status={status}
                title={info.title}
                onClick={() => interactive && onFocusStep?.(step)}
                onMouseEnter={() => setHoveredStep(step)}
                onMouseLeave={() =>
                  setHoveredStep((current) =>
                    current === step ? null : current
                  )
                }
                onFocus={() => setHoveredStep(step)}
                onBlur={() =>
                  setHoveredStep((current) =>
                    current === step ? null : current
                  )
                }
                disabled={!onFocusStep}
                aria-disabled={!interactive}
                className={cn(
                  "flex h-6 items-center justify-center rounded-md border px-2.5 text-[11px] transition-colors",
                  interactive
                    ? "cursor-pointer hover:brightness-95"
                    : "cursor-default",
                  status === "pass" &&
                    "border-green-600/40 bg-green-500/15 text-green-700 dark:text-green-400",
                  status === "fail" &&
                    "border-red-600/50 bg-red-500/15 text-red-600 dark:text-red-400",
                  status === "untouched" &&
                    isCurrent &&
                    "border-blue-500/50 bg-blue-500/15 text-blue-600 dark:text-blue-400",
                  status === "untouched" &&
                    !isCurrent &&
                    "border-border bg-muted text-muted-foreground",
                  isFocused && "ring-1 ring-blue-400"
                )}
              >
                {STEP_NUMBERS[step] ?? ""}
              </button>
            </li>
          );
        })}
      </ol>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {hoveredStep ? getXAAStepInfo(hoveredStep).title : ""}
      </span>
    </div>
  );
}
