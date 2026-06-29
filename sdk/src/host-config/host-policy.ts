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
import type {
  McpToolResultImageRendering,
  ModelVisibleMcpToolResults,
} from "./types.js";

export type { ToolExposureSignals } from "./tool-visibility.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the host style from either shape:
 *   - canonical / internal storage (`hostStyle`)
 *   - public `HostJson` from `Host.toJSON()` (`style`)
 *
 * Both helpers in this module operate on either shape because callers
 * span: inspector eval runners (canonical, via Convex), SDK `HostRunner`
 * (public, via `Host.toJSON()`), and unit tests on both.
 */
function readHostStyle(
  hostConfig: Record<string, unknown>
): string | undefined {
  if (typeof hostConfig.hostStyle === "string") return hostConfig.hostStyle;
  if (typeof hostConfig.style === "string") return hostConfig.style;
  return undefined;
}

export type ResolvedModelVisibleMcpToolResults = {
  directContent: {
    text: boolean;
    image: boolean;
    audio: boolean;
  };
  embeddedResources: {
    text: boolean;
    blob: {
      enabled: boolean;
      image: boolean;
      audio: boolean;
      document: boolean;
      video: boolean;
      otherBinary: boolean;
    };
  };
  linkedResources: {
    text: boolean;
    blob: {
      enabled: boolean;
      image: boolean;
      audio: boolean;
      document: boolean;
      video: boolean;
      otherBinary: boolean;
    };
  };
};

export const DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS: ResolvedModelVisibleMcpToolResults =
  {
    directContent: {
      text: true,
      image: true,
      audio: false,
    },
    embeddedResources: {
      text: false,
      blob: {
        enabled: true,
        image: true,
        audio: false,
        document: false,
        video: false,
        otherBinary: false,
      },
    },
    linkedResources: {
      text: false,
      blob: {
        enabled: true,
        image: true,
        audio: false,
        document: false,
        video: false,
        otherBinary: false,
      },
    },
  };

function readModelVisibleMcpToolResults(
  hostConfig: Record<string, unknown>
): ModelVisibleMcpToolResults | undefined {
  const value = hostConfig.modelVisibleMcpToolResults;
  return isRecord(value) ? (value as ModelVisibleMcpToolResults) : undefined;
}

export function resolveModelVisibleMcpToolResults(
  policy: ModelVisibleMcpToolResults | undefined
): ResolvedModelVisibleMcpToolResults {
  const embeddedBlobEnabled =
    policy?.embeddedResources?.blob?.enabled ??
    DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.embeddedResources.blob.enabled;
  const linkedBlobEnabled =
    policy?.linkedResources?.blob?.enabled ??
    DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.linkedResources.blob.enabled;

  return {
    directContent: {
      text:
        policy?.directContent?.text ??
        DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.directContent.text,
      image:
        policy?.directContent?.image ??
        DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.directContent.image,
      audio:
        policy?.directContent?.audio ??
        DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.directContent.audio,
    },
    embeddedResources: {
      text:
        policy?.embeddedResources?.text ??
        DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.embeddedResources.text,
      blob: {
        enabled: embeddedBlobEnabled,
        image:
          embeddedBlobEnabled &&
          (policy?.embeddedResources?.blob?.image ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.embeddedResources.blob
              .image),
        audio:
          embeddedBlobEnabled &&
          (policy?.embeddedResources?.blob?.audio ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.embeddedResources.blob
              .audio),
        document:
          embeddedBlobEnabled &&
          (policy?.embeddedResources?.blob?.document ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.embeddedResources.blob
              .document),
        video:
          embeddedBlobEnabled &&
          (policy?.embeddedResources?.blob?.video ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.embeddedResources.blob
              .video),
        otherBinary:
          embeddedBlobEnabled &&
          (policy?.embeddedResources?.blob?.otherBinary ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.embeddedResources.blob
              .otherBinary),
      },
    },
    linkedResources: {
      text:
        policy?.linkedResources?.text ??
        DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.linkedResources.text,
      blob: {
        enabled: linkedBlobEnabled,
        image:
          linkedBlobEnabled &&
          (policy?.linkedResources?.blob?.image ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.linkedResources.blob.image),
        audio:
          linkedBlobEnabled &&
          (policy?.linkedResources?.blob?.audio ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.linkedResources.blob.audio),
        document:
          linkedBlobEnabled &&
          (policy?.linkedResources?.blob?.document ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.linkedResources.blob
              .document),
        video:
          linkedBlobEnabled &&
          (policy?.linkedResources?.blob?.video ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.linkedResources.blob.video),
        otherBinary:
          linkedBlobEnabled &&
          (policy?.linkedResources?.blob?.otherBinary ??
            DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS.linkedResources.blob
              .otherBinary),
      },
    },
  };
}

function readMcpToolResultImageRendering(
  hostConfig: Record<string, unknown>
): McpToolResultImageRendering | undefined {
  const value = hostConfig.mcpToolResultImageRendering;
  return value === "none" || value === "panel" || value === "inline"
    ? value
    : undefined;
}

export type HostExecutionPolicy = {
  requireToolApproval: boolean;
  /** undefined = spec default (filter app-only tools from model). false = opt out. */
  respectToolVisibility: boolean | undefined;
  progressiveDiscoveryEnabled: boolean;
  /**
   * Whether eligible MCP image-bearing tool-result content should be passed
   * through as model-visible image content instead of staying as JSON. These
   * are host/client capabilities, not storage or UI-rendering concerns.
   */
  modelVisibleMcpToolResults: ResolvedModelVisibleMcpToolResults;
  mcpToolResultImageRendering: McpToolResultImageRendering;
  hostStyle: string | undefined;
  namedHostId: string | undefined;
};

export function extractHostExecutionPolicy(
  hostConfig: Record<string, unknown> | null,
  namedHostId?: string
): HostExecutionPolicy {
  if (!hostConfig) {
    return {
      requireToolApproval: false,
      respectToolVisibility: undefined,
      progressiveDiscoveryEnabled: false,
      modelVisibleMcpToolResults: DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS,
      mcpToolResultImageRendering: "inline",
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

  const hostStyle = readHostStyle(hostConfig);
  const modelVisibleMcpToolResults = resolveModelVisibleMcpToolResults(
    readModelVisibleMcpToolResults(hostConfig)
  );
  const mcpToolResultImageRendering =
    readMcpToolResultImageRendering(hostConfig) ?? "inline";

  return {
    requireToolApproval,
    respectToolVisibility,
    progressiveDiscoveryEnabled,
    modelVisibleMcpToolResults,
    mcpToolResultImageRendering,
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
  hostConfig: Record<string, unknown> | null
): Record<string, string | number | boolean> {
  if (!hostConfig) {
    return {};
  }

  const policy = extractHostExecutionPolicy(hostConfig);
  const meta: Record<string, string | number | boolean> = {};
  if (policy.progressiveDiscoveryEnabled) {
    meta.progressive_discovery_enabled = true;
  }
  if (policy.modelVisibleMcpToolResults.directContent.image) {
    meta.model_visible_mcp_direct_content_image = true;
  }
  if (policy.modelVisibleMcpToolResults.embeddedResources.blob.image) {
    meta.model_visible_mcp_embedded_resource_blob_image = true;
  }
  if (policy.modelVisibleMcpToolResults.linkedResources.blob.image) {
    meta.model_visible_mcp_linked_resource_blob_image = true;
  }
  if (policy.mcpToolResultImageRendering !== "inline") {
    meta.mcp_tool_result_image_rendering = policy.mcpToolResultImageRendering;
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
  injectOpenAiCompat: boolean
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
  if (policy.modelVisibleMcpToolResults.directContent.image) {
    meta.model_visible_mcp_direct_content_image = true;
  }
  if (policy.modelVisibleMcpToolResults.embeddedResources.blob.image) {
    meta.model_visible_mcp_embedded_resource_blob_image = true;
  }
  if (policy.modelVisibleMcpToolResults.linkedResources.blob.image) {
    meta.model_visible_mcp_linked_resource_blob_image = true;
  }
  if (policy.mcpToolResultImageRendering !== "inline") {
    meta.mcp_tool_result_image_rendering = policy.mcpToolResultImageRendering;
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
