/**
 * Extracts host execution policy from a hostConfig snapshot and provides
 * helpers to compute tool exposure signals and stamp scalar iteration metadata.
 *
 * Uses the same policy switches as chat-v2 (`requireToolApproval`,
 * `respectToolVisibility`, `progressiveToolDiscovery`) without duplicating
 * their semantics. The visibility filter itself is imported from
 * `chat-v2-orchestration` so the filtering logic stays authoritative.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import { filterAppOnlyTools } from "../../utils/chat-v2-orchestration.js";

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

export type ToolExposureSignals = {
  toolsTotalBefore: number;
  toolsExposed: number;
  toolsDroppedVisibility: number;
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

  // HostConfigV2 stores this as a plain boolean; chat-v2 wire payloads wrap
  // it as `{ enabled, threshold }`. Accept both shapes so iteration metadata
  // is stamped regardless of which form the snapshot was built from.
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
 * Applies the host visibility policy to `tools` (mutates in place, same as
 * `prepareChatV2`) and returns tool exposure counts for metadata stamping.
 *
 * Call this AFTER loading the full tool set so `toolsTotalBefore` is accurate.
 */
export function applyVisibilityPolicyAndCountSignals(
  tools: Record<string, unknown>,
  manager: InstanceType<typeof MCPClientManager>,
  policy: HostExecutionPolicy,
): ToolExposureSignals {
  const toolsTotalBefore = Object.keys(tools).length;
  if (policy.respectToolVisibility !== false) {
    filterAppOnlyTools(tools as Parameters<typeof filterAppOnlyTools>[0], manager);
  }
  const toolsExposed = Object.keys(tools).length;
  return {
    toolsTotalBefore,
    toolsExposed,
    toolsDroppedVisibility: toolsTotalBefore - toolsExposed,
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
