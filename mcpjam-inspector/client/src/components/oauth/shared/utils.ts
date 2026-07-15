import type { OAuthFlowStep } from "@mcpjam/sdk/browser";
import type { NodeStatus } from "./types";

// Helper to determine status based on current step and actual action order
export const getActionStatus = (
  actionStep: OAuthFlowStep | string,
  currentStep: string,
  actionsInFlow: Array<{ id: string }>
): NodeStatus => {
  // Find indices in the actual flow (not a hardcoded order)
  const actionIndex = actionsInFlow.findIndex((a) => a.id === actionStep);
  const currentIndex = actionsInFlow.findIndex((a) => a.id === currentStep);

  // If step not found in flow, it's pending
  if (actionIndex === -1) return "pending";

  // The current state is the action that is active right now. Keep the next
  // action pending until the state machine advances to it.
  if (actionIndex < currentIndex) return "complete";
  if (actionIndex === currentIndex) return "current";
  return "pending";
};
