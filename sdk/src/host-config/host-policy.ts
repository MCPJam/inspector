/**
 * Host execution policy extraction + iteration-metadata stamping.
 *
 * Pure — derived from a hostConfig snapshot. Used by both the live chat
 * runtime (via `prepareChatV2`'s `respectToolVisibility` gate) and the eval
 * runtime (via `applyVisibilityPolicyAndCountSignals` + `buildHostIterationMetadata`).
 *
 * `extractHostExecutionPolicy` accepts the dual progressiveToolDiscovery
 * shape because HostConfigV2 stores it as a plain boolean while chat-v2
 * wire payloads wrap it as `{ enabled, threshold }`. Both flow through here.
 */

import type { ToolExposureSignals } from "./tool-visibility.js";

export type { ToolExposureSignals } from "./tool-visibility.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type HostExecutionPolicy = {
  requireToolApproval: boolean;
  /** undefined = spec default (filter app-only tools from model). false = opt out. */
  respectToolVisibility: boolean | undefined;
  progressiveDiscoveryEnabled: boolean;
  hostStyle: string | undefined;
  namedHostId: string | undefined;
};

export function extractHostExecutionPolicy(
  hostConfig: Record<string, unknown> | null,
  namedHostId?: string,
): HostExecutionPolicy {
  if (!hostConfig) {
    return {
      requireToolApproval: false,
      respectToolVisibility: undefined,
      progressiveDiscoveryEnabled: false,
      hostStyle: undefined,
      namedHostId,
    };
  }

  const requireToolApproval =
    typeof hostConfig.requireToolApproval === "boolean"
      ? hostConfig.requireToolApproval
      : false;

  const respectToolVisibility =
    typeof hostConfig.respectToolVisibility === "boolean"
      ? hostConfig.respectToolVisibility
      : undefined;

  const discoveryRaw = hostConfig.progressiveToolDiscovery;
  const progressiveDiscoveryEnabled =
    typeof discoveryRaw === "boolean"
      ? discoveryRaw
      : isRecord(discoveryRaw) && discoveryRaw.enabled === true;

  const hostStyle =
    typeof hostConfig.hostStyle === "string" ? hostConfig.hostStyle : undefined;

  return {
    requireToolApproval,
    respectToolVisibility,
    progressiveDiscoveryEnabled,
    hostStyle,
    namedHostId,
  };
}

/**
 * Builds the scalar host-policy metadata fields to merge into
 * `EvalIteration.metadata`. Only includes keys with meaningful values to
 * avoid inflating rows with zero-valued noise.
 *
 * The `approvalsWouldRequire` count is the number of tool calls that
 * actually occurred in this iteration and would have required approval
 * under the host's `requireToolApproval` policy. Evals do not block on
 * approval prompts — this is a "would prompt N times" signal only.
 */
/**
 * Snapshot-only host metadata for SDK eval reports. Subset of
 * {@link buildHostIterationMetadata} that needs no per-iteration counters
 * (signals / approvalsWouldRequire / injectOpenAiCompat) and can be
 * derived from `Host.toJSON()` alone.
 *
 * Used by SDK eval result mapping to stamp executor-derived host context
 * onto each iteration's metadata. Per-iteration signal counts (tools
 * exposed / dropped, approvals required) are added by callers that have
 * runtime access (inspector eval runner, future `HostRuntime` plumbing).
 */
export function buildHostSnapshotMetadata(
  hostConfig: Record<string, unknown> | null,
): Record<string, string | number | boolean> {
  const policy = extractHostExecutionPolicy(hostConfig);
  const meta: Record<string, string | number | boolean> = {};
  if (policy.progressiveDiscoveryEnabled) {
    meta.progressive_discovery_enabled = true;
  }
  if (policy.namedHostId) {
    meta.host_id = policy.namedHostId;
  }
  if (policy.hostStyle) {
    meta.host_style = policy.hostStyle;
  }
  return meta;
}

export function buildHostIterationMetadata(
  policy: HostExecutionPolicy,
  signals: ToolExposureSignals,
  approvalsWouldRequire: number,
  injectOpenAiCompat: boolean,
): Record<string, string | number | boolean> {
  const meta: Record<string, string | number | boolean> = {
    tools_total_before: signals.toolsTotalBefore,
    tools_exposed: signals.toolsExposed,
  };

  if (signals.toolsDroppedVisibility > 0) {
    meta.tools_dropped_visibility = signals.toolsDroppedVisibility;
  }
  if (policy.requireToolApproval && approvalsWouldRequire > 0) {
    meta.approvals_would_require = approvalsWouldRequire;
  }
  if (policy.progressiveDiscoveryEnabled) {
    meta.progressive_discovery_enabled = true;
  }
  if (injectOpenAiCompat) {
    meta.openai_compat_injected = true;
  }
  if (policy.namedHostId) {
    meta.host_id = policy.namedHostId;
  }
  if (policy.hostStyle) {
    meta.host_style = policy.hostStyle;
  }
  return meta;
}
