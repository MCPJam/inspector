import { isUIResource } from "@mcp-ui/client";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

export enum UIType {
  MCP_APPS = "mcp-apps",
  OPENAI_SDK = "openai-sdk",
  MCP_UI = "mcp-ui",
}

export function detectUIType(
  toolMeta: Record<string, unknown> | undefined,
  toolResult: unknown,
): UIType | null {
  // 1. OpenAI SDK: Check for openai/outputTemplate metadata
  if (toolMeta?.["openai/outputTemplate"]) {
    return UIType.OPENAI_SDK;
  }

  // 2. MCP Apps (SEP-1865): Check for ui.resourceUri metadata
  if (getToolUiResourceUri({ _meta: toolMeta })) {
    return UIType.MCP_APPS;
  }

  // 3. MCP-UI: Check for inline ui:// resource in result
  const directResource = (toolResult as { resource?: { uri?: string } })
    ?.resource;
  if (directResource?.uri?.startsWith("ui://")) {
    return UIType.MCP_UI;
  }

  const content = (toolResult as { content?: unknown[] })?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      // isUIResource is a type guard, cast to any for runtime type check
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
      return getToolUiResourceUri({ _meta: toolMeta }) ?? null;
    case UIType.OPENAI_SDK:
      return (toolMeta?.["openai/outputTemplate"] as string) ?? null;
    default:
      return null;
  }
}

export function isMCPApp(
  toolsData?: ListToolsResultWithMetadata | null,
): boolean {
  const metadata = toolsData?.toolsMetadata;
  if (!metadata) return false;

  return Object.values(metadata).some(
    (meta) => getToolUiResourceUri({ _meta: meta }) != null,
  );
}

export function isOpenAIApp(
  toolsData?: ListToolsResultWithMetadata | null,
): boolean {
  const metadata = toolsData?.toolsMetadata;
  if (!metadata) return false;

  return Object.values(metadata).some(
    (meta) =>
      (meta as Record<string, unknown> | undefined)?.[
        "openai/outputTemplate"
      ] != null,
  );
}
