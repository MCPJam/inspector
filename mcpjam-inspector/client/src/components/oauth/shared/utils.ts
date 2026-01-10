import type { OAuthFlowStep } from "@/lib/oauth/state-machines/types";
import type { NodeStatus } from "./types";

// Helper to determine status based on current step and actual action order
export const getActionStatus = (
  actionStep: OAuthFlowStep | string,
  currentStep: OAuthFlowStep,
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
