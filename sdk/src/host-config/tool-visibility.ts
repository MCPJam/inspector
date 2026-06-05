/**
 * SEP-1865 host visibility filter and exposure-signal counting.
 *
 * Structurally pure — depends only on `isAppOnlyTool` (a pure leaf) and the
 * `HostExecutionPolicy` type. Does NOT import `MCPClientManager` or any AI
 * SDK code, so this module can ship from `@mcpjam/sdk/host-config/internal`
 * (which the inspector client imports as source via Vite alias) without
 * dragging Node-heavy deps into the browser bundle.
 *
 * The `ToolMetadataSource` duck-type below is satisfied by
 * `MCPClientManager` (its `getAllToolsMetadata` signature matches), so
 * inspector callers pass their existing manager unchanged.
 */

import { isAppOnlyTool } from "./app-only-tool.js";
import type { HostExecutionPolicy } from "./host-policy.js";

/**
 * Structural type for anything that can supply per-server tool metadata.
 * `MCPClientManager.getAllToolsMetadata(serverId)` satisfies this.
 */
export interface ToolMetadataSource {
  getAllToolsMetadata(
    serverId: string,
  ): Record<string, Record<string, unknown>>;
}

export type ToolExposureSignals = {
  toolsTotalBefore: number;
  toolsExposed: number;
  toolsDroppedVisibility: number;
};

/**
 * Mutates `tools` in place, removing entries whose source MCP tool declares
 * SEP-1865 `_meta.ui.visibility` as exactly `["app"]`.
 *
 * Per SEP-1865, the visibility array defaults to `["model", "app"]` so a tool
 * with no visibility metadata is treated as visible to both.
 *
 * `tools` is expected to be the tool-set shape produced by
 * `MCPClientManager.getToolsForAiSdk(...)` — each entry carries a `_serverId`
 * string used to look up its source metadata. Tools without `_serverId` are
 * left untouched (they did not originate from an MCP server).
 */
export function filterAppOnlyTools(
  tools: Record<string, unknown>,
  source: ToolMetadataSource,
): void {
  // Cache per-server metadata maps so we don't repeatedly clone them.
  const metaByServer = new Map<
    string,
    Record<string, Record<string, unknown>>
  >();
  const getMeta = (serverId: string) => {
    let cached = metaByServer.get(serverId);
    if (!cached) {
      cached = source.getAllToolsMetadata(serverId);
      metaByServer.set(serverId, cached);
    }
    return cached;
  };

  for (const [name, tool] of Object.entries(tools)) {
    const serverId = (tool as { _serverId?: unknown })._serverId;
    if (typeof serverId !== "string") continue;
    const meta = getMeta(serverId)[name];
    if (isAppOnlyTool(meta)) {
      delete tools[name];
    }
  }
}

/**
 * Applies the host visibility policy to `tools` (mutates in place, same as
 * `prepareChatV2`) and returns tool exposure counts for iteration metadata
 * stamping.
 *
 * Call this AFTER loading the full tool set so `toolsTotalBefore` is accurate.
 */
export function applyVisibilityPolicyAndCountSignals(
  tools: Record<string, unknown>,
  source: ToolMetadataSource,
  policy: HostExecutionPolicy,
): ToolExposureSignals {
  const toolsTotalBefore = Object.keys(tools).length;
  if (policy.respectToolVisibility !== false) {
    filterAppOnlyTools(tools, source);
  }
  const toolsExposed = Object.keys(tools).length;
  return {
    toolsTotalBefore,
    toolsExposed,
    toolsDroppedVisibility: toolsTotalBefore - toolsExposed,
  };
}
