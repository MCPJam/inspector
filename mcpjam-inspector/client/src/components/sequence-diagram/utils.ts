import type { NodeStatus } from "./types";

/**
 * Determine the status of an action based on the current step position.
 * Generic version — uses string instead of OAuthFlowStep.
 */
export const getActionStatus = (
  actionStep: string,
  currentStep: string,
  actionsInFlow: Array<{ id: string }>,
): NodeStatus => {
  // Find indices in the actual flow (not a hardcoded order)
  const actionIndex = actionsInFlow.findIndex((a) => a.id === actionStep);
  const currentIndex = actionsInFlow.findIndex((a) => a.id === currentStep);

  // If step not found in flow, it's pending
  if (actionIndex === -1) return "pending";

  // Show completed steps (everything up to and including current)
  if (actionIndex <= currentIndex) return "complete";
  // Show the NEXT step as current (what will happen when you click Next Step)
  if (actionIndex === currentIndex + 1) return "current";
  return "pending";
};
