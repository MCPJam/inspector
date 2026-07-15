import type { InfoLogEntry, OAuthFlowState } from "../types.js";
import {
  evaluateResourceIndicator,
  resolveResourceIndicatorValue,
  type ResourceIndicatorDecision,
} from "../../resource-policy.js";
import { addResourceMismatchWarning } from "./logging.js";

// Shared between the 2025-06-18 and 2025-11-25 debug machines so the two
// copies of the resource-indicator plumbing cannot drift.

/**
 * The resource value a flow sends/displays: the decision persisted at PRM
 * discovery, re-evaluated lazily for flows seeded past discovery.
 */
export function resolveFlowResourceValue(
  flowState: OAuthFlowState,
  fallbackServerUrl: string,
): string;
export function resolveFlowResourceValue(
  flowState: OAuthFlowState,
  fallbackServerUrl?: string,
): string | undefined;
export function resolveFlowResourceValue(
  flowState: OAuthFlowState,
  fallbackServerUrl?: string,
): string | undefined {
  return resolveResourceIndicatorValue({
    serverUrl: flowState.serverUrl ?? fallbackServerUrl,
    prmResource: flowState.resourceMetadata?.resource,
    resolved: flowState.resourceIndicator,
  });
}

/**
 * The discovery-step half of the policy: evaluate the advertised resource
 * ONCE, enforce per the surface's mode (reject → throw, which the machine's
 * discovery error path turns into a failed step), and append the mismatch
 * warning for warn-mode surfaces. The returned decision is what the machine
 * persists as `state.resourceIndicator`.
 */
export function resolveDiscoveryResourceIndicator(input: {
  state: OAuthFlowState;
  fallbackServerUrl: string;
  prmResource: string | undefined;
  enforcement: "warn" | "reject";
  infoLogs: Array<InfoLogEntry>;
}): { resourceIndicator: ResourceIndicatorDecision; infoLogs: Array<InfoLogEntry> } {
  const serverUrl = input.state.serverUrl ?? input.fallbackServerUrl;

  const resourceIndicator = evaluateResourceIndicator({
    serverUrl,
    prmResource: input.prmResource,
  });

  if (
    input.enforcement === "reject" &&
    resourceIndicator.source === "prm" &&
    resourceIndicator.status !== "valid"
  ) {
    throw new Error(
      resourceIndicator.reason ??
        "Protected Resource Metadata advertises an unusable resource identifier.",
    );
  }

  const infoLogs = addResourceMismatchWarning(
    input.state,
    input.infoLogs,
    resourceIndicator,
    serverUrl,
  );

  return { resourceIndicator, infoLogs };
}
