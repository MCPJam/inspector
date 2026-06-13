import { cn } from "@/lib/utils";
import {
  getXAAStepIndex,
  getXAAStepInfo,
  XAA_STEP_ORDER,
} from "@/lib/xaa/step-metadata";
import type { XAAFlowState, XAAFlowStep } from "@/lib/xaa/types";

// "idle" and "complete" are machine states, not work the run performs.
const CHIP_STEPS: XAAFlowStep[] = XAA_STEP_ORDER.filter(
  (step) => step !== "idle" && step !== "complete",
);

type ChipStatus = "pass" | "fail" | "untouched";

export function chipStatusFor(
  step: XAAFlowStep,
  flowState: Pick<XAAFlowState, "currentStep" | "error">,
): ChipStatus {
  const stepIndex = getXAAStepIndex(step);
  const currentIndex = getXAAStepIndex(flowState.currentStep);

  if (flowState.error && step === flowState.currentStep) {
    return "fail";
  }
  if (stepIndex < currentIndex || flowState.currentStep === "complete") {
    return "pass";
  }
  // The step the flow sits on without an error hasn't finished yet.
  return "untouched";
}

/**
 * Per-step pass/fail strip for the flow runner. A run stopped mid-flow shows
 * green (done) / red (failed) / untouched chips rather than all-or-nothing.
 */
export function XAARunChips({
  flowState,
}: {
  flowState: Pick<XAAFlowState, "currentStep" | "error">;
}) {
  return (
    <ol aria-label="Run progress" className="flex flex-wrap items-center gap-1">
      {CHIP_STEPS.map((step) => {
        const status = chipStatusFor(step, flowState);
        return (
          <li
            key={step}
            data-testid={`xaa-run-chip-${step}`}
            data-status={status}
            title={getXAAStepInfo(step).title}
            className={cn(
              "h-2 w-5 rounded-full border",
              status === "pass" &&
                "border-green-600/40 bg-green-500/70 dark:bg-green-500/50",
              status === "fail" &&
                "border-red-600/40 bg-red-500/80 dark:bg-red-500/60",
              status === "untouched" && "border-border bg-muted",
            )}
          />
        );
      })}
    </ol>
  );
}
