// UI-type detection for widget-bearing tool calls. Relocated from the inspector
// (`@/lib/mcp-ui/mcp-apps-utils`) in Phase 3d-ii; depends only on ext-apps +
// @mcp-ui/client + the SDK tool-visibility leaf. The inspector keeps the
// `ListToolsResultWithMetadata`-typed `isMCPApp`/`isOpenAIApp` helpers (they
// need an inspector api type) and re-exports this core.
import { isUIResource } from "@mcp-ui/client";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * Minimal structural shape `detectUiTypeFromTool` needs — just the `_meta` bag.
 * Kept structural (rather than importing `Tool` from
 * `@modelcontextprotocol/client`) so the package's public detection surface
 * doesn't pin a specific MCP SDK Tool type; any `{ _meta }`-bearing tool works.
 */
export interface ToolLike {
  _meta?: Record<string, unknown>;
}

// SEP-1865 tool-visibility helpers live in the framework-free SDK leaf so the
// host bridge and the renderer share one model-only visibility check. Re-exported
// here to preserve the existing `mcp-apps-utils` import surface.
export {
  getToolVisibility,
  isVisibleToModelOnly,
  isVisibleToAppOnly,
} from "@mcpjam/sdk/widget-runtime";

export enum UIType {
  MCP_APPS = "mcp-apps",
  OPENAI_SDK = "openai-sdk",
  OPENAI_SDK_AND_MCP_APPS = "openai-sdk-and-mcp-apps",
  MCP_UI = "mcp-ui",
}

export function detectUiTypeFromTool(tool: ToolLike): UIType | null {
  const toolMeta = tool._meta;
  if (!toolMeta) return null;
  return detectUIType(toolMeta, undefined);
}

export function detectUIType(
  toolMeta: Record<string, unknown> | undefined,
  toolResult: unknown,
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

  // 4. MCP-UI: inline ui:// resource in result
  const directResource = (toolResult as { resource?: { uri?: string } })
    ?.resource;
  if (directResource?.uri?.startsWith("ui://")) {
    return UIType.MCP_UI;
  }

  const content = (toolResult as { content?: unknown[] })?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      // isUIResource is a type guard; cast to any for the runtime check.
      if (isUIResource(item as any)) {
        return UIType.MCP_UI;
      }
    }
  }
  return null;
}

export function getUIResourceUri(
  uiType: UIType | null,
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  switch (uiType) {
    case UIType.MCP_APPS:
    case UIType.OPENAI_SDK_AND_MCP_APPS:
      return getToolUiResourceUri({ _meta: toolMeta }) ?? null;
    case UIType.OPENAI_SDK:
      return (toolMeta?.["openai/outputTemplate"] as string) ?? null;
    default:
      return null;
  }
}
