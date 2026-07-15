import type { XAAFlowState, XAAFlowStep, XAAStateMachine } from "./types.js";

export interface RunXaaStateMachineOptions {
  /** Max `proceedToNextStep` calls before bailing (hot-loop guard). Default 40. */
  maxSteps?: number;
  /** Stop once the machine reaches this step, before advancing past it. */
  stopAtStep?: XAAFlowStep;
  /** Stop when this predicate returns true for the current state. */
  stopWhen?: (state: XAAFlowState) => boolean;
}

export interface XaaStateMachineRunResult {
  completed: boolean;
  stoppedAt: XAAFlowStep;
  error?: string;
  state: XAAFlowState;
}

/**
 * Drive an XAA state machine until completion, a stop predicate/step, an error,
 * a settled negative-probe, or the max-steps guard — whichever comes first.
 * Reads state through `getState` (the same callback the machine was configured
 * with) so it always observes live state. Unlike the machine's own `runAll`,
 * this supports an explicit stop step/predicate for partial or stepped runs.
 */
export async function runXaaStateMachine(
  machine: XAAStateMachine,
  getState: () => XAAFlowState,
  options: RunXaaStateMachineOptions = {},
): Promise<XaaStateMachineRunResult> {
  const maxSteps = options.maxSteps ?? 40;
  for (let i = 0; i < maxSteps; i++) {
    const state = getState();
    if (
      state.currentStep === "complete" ||
      state.error ||
      state.negativeProbe ||
      (options.stopAtStep !== undefined &&
        state.currentStep === options.stopAtStep) ||
      options.stopWhen?.(state)
    ) {
      break;
    }
    const before = state.currentStep;
    await machine.proceedToNextStep();
    // No progress and no error/complete — bail rather than loop forever.
    if (getState().currentStep === before) break;
  }
  const finalState = getState();
  return {
    completed: finalState.currentStep === "complete",
    stoppedAt: finalState.currentStep,
    error: finalState.error,
    state: finalState,
  };
}
