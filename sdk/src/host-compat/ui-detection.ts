import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * Narrow, host-compat-specific bridge detection from a tool's `_meta`.
 *
 * This is NOT canonical widget detection — it deliberately classifies only the
 * `_meta`-declared bridge (MCP Apps `ui.resourceUri` and/or OpenAI Apps
 * `openai/outputTemplate`), which is all the compat engine needs to bucket a
 * tool. It does NOT scan tool *results* for inline `ui://` resources; the
 * canonical detector that does lives in `@mcpjam/widget-react`. Named narrowly
 * so it can't be mistaken for general detection.
 */

/** The widget bridge a tool declares in its `_meta`. */
export enum HostCompatBridge {
  /** MCP Apps only (`_meta.ui.resourceUri`). */
  MCP_APPS = "mcp-apps",
  /** OpenAI Apps only (`openai/outputTemplate`). */
  OPENAI_SDK = "openai-sdk",
  /** Declares both bridges. */
  OPENAI_SDK_AND_MCP_APPS = "openai-sdk-and-mcp-apps",
}

export function detectHostCompatBridgeFromMeta(
  toolMeta: Record<string, unknown> | undefined,
): HostCompatBridge | null {
  const hasOpenAi = Boolean(toolMeta?.["openai/outputTemplate"]);
  const hasMcpApps = Boolean(getToolUiResourceUri({ _meta: toolMeta }));
  if (hasOpenAi && hasMcpApps) return HostCompatBridge.OPENAI_SDK_AND_MCP_APPS;
  if (hasOpenAi) return HostCompatBridge.OPENAI_SDK;
  if (hasMcpApps) return HostCompatBridge.MCP_APPS;
  return null;
}
