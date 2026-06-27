import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * UI-type detection for widget-bearing tool calls — the classification the
 * compat engine uses to bucket a tool's widget (MCP Apps vs OpenAI Apps vs
 * both). Mirrors `@mcpjam/widget-react`'s `detectUIType` for the `_meta` path
 * (the engine never passes a tool *result*). Kept here so the engine has no
 * dependency on widget-react (which depends on `@mcpjam/sdk` — importing it
 * back would be a package cycle); widget-react can re-export from here.
 */

export enum UIType {
  MCP_APPS = "mcp-apps",
  OPENAI_SDK = "openai-sdk",
  OPENAI_SDK_AND_MCP_APPS = "openai-sdk-and-mcp-apps",
  MCP_UI = "mcp-ui",
}

export function detectUIType(
  toolMeta: Record<string, unknown> | undefined,
  toolResult?: unknown,
): UIType | null {
  // 1. OpenAI SDK and MCP Apps: openai/outputTemplate AND ui.resourceUri
  if (
    toolMeta?.["openai/outputTemplate"] &&
    getToolUiResourceUri({ _meta: toolMeta })
  ) {
    return UIType.OPENAI_SDK_AND_MCP_APPS;
  }

  // 2. OpenAI SDK: openai/outputTemplate
  if (toolMeta?.["openai/outputTemplate"]) {
    return UIType.OPENAI_SDK;
  }

  // 3. MCP Apps (SEP-1865): ui.resourceUri
  if (getToolUiResourceUri({ _meta: toolMeta })) {
    return UIType.MCP_APPS;
  }

  // 4. MCP-UI: inline ui:// resource in result. The full inspector/widget-react
  //    detector also scans the result `content[]` via `@mcp-ui/client`'s
  //    `isUIResource`; the compat engine only classifies by `_meta` (it passes
  //    no result), so the lighter direct-uri check suffices here.
  const directResource = (toolResult as { resource?: { uri?: string } })
    ?.resource;
  if (directResource?.uri?.startsWith("ui://")) {
    return UIType.MCP_UI;
  }

  return null;
}
