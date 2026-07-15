import type { InfoLogEntry, OAuthFlowState } from "../types.js";
import {
  evaluateResourceIndicator,
  resolveResourceIndicatorValue,
  type ResourceIndicatorDecision,
} from "../../resource-policy.js";
import { addInfoLog, addResourceMismatchWarning } from "./logging.js";

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
 * ONCE, enforce per the surface's mode (`reject` rejects unsafe values;
 * `reject-rfc9728` also rejects noncompliant interoperability exceptions), and
 * append the mismatch warning. The returned decision is what the machine
 * persists as `state.resourceIndicator`.
 */
export function resolveDiscoveryResourceIndicator(input: {
  state: OAuthFlowState;
  fallbackServerUrl: string;
  prmResource: string | undefined;
  enforcement: "warn" | "reject" | "reject-rfc9728";
  infoLogs: Array<InfoLogEntry>;
}): { resourceIndicator: ResourceIndicatorDecision; infoLogs: Array<InfoLogEntry> } {
  const serverUrl = input.state.serverUrl ?? input.fallbackServerUrl;

  // A fetched PRM document without its REQUIRED `resource` (RFC 9728 §2) is
  // broken metadata — distinguishable from "no PRM discovered". Reject-mode
  // surfaces fail discovery (matching selectResourceURL); warn-mode surfaces
  // log it and proceed on the server-URL fallback so the flow stays
  // observable.
  const prmResource = input.prmResource?.trim();
  if (!prmResource) {
    const reason =
      'Protected Resource Metadata is missing its required "resource" identifier (RFC 9728 §2).';

    if (input.enforcement !== "warn") {
      throw new Error(reason);
    }

    const resourceIndicator = evaluateResourceIndicator({ serverUrl });
    const infoLogs = addInfoLog(
      { ...input.state, infoLogs: input.infoLogs },
      "received_resource_metadata",
      "resource-identifier-mismatch",
      "Resource identifier missing",
      {
        "Server URL": serverUrl,
        Reason: reason,
        Note: "The debugger will fall back to the server URL as the resource indicator, but strict MCP clients treat this metadata as invalid.",
      },
      { level: "warning" },
    );
    return { resourceIndicator, infoLogs };
  }

  const resourceIndicator = evaluateResourceIndicator({
    serverUrl,
    prmResource,
  });

  const rejectUnusable =
    input.enforcement !== "warn" && resourceIndicator.status !== "valid";
  const rejectNoncompliant =
    input.enforcement === "reject-rfc9728" &&
    !resourceIndicator.rfc9728Compliant;

  if (
    resourceIndicator.source === "prm" &&
    (rejectUnusable || rejectNoncompliant)
  ) {
    throw new Error(
      (rejectNoncompliant ? resourceIndicator.rfc9728Reason : undefined) ??
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
