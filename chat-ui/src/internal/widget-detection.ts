/**
 * Minimal, dependency-free widget detection.
 *
 * The inspector's `@/lib/mcp-ui/mcp-apps-utils` performs the same detection
 * but pulls in the MCP Apps SDK (`@modelcontextprotocol/ext-apps`) and
 * `@mcp-ui/client`. Tier A only needs to know *whether* a tool is
 * widget-bearing so it can render a placeholder — it never mounts a widget —
 * so we re-implement the meta-key checks locally and keep the package free of
 * any widget-runtime dependency.
 */

export enum UIType {
  MCP_APPS = "mcp-apps",
  OPENAI_SDK = "openai-sdk",
  OPENAI_SDK_AND_MCP_APPS = "openai-sdk-and-mcp-apps",
  MCP_UI = "mcp-ui",
}

/**
 * MCP Apps (SEP-1865) and OpenAI Apps SDK templates both surface their widget
 * resource under `_meta.ui.resourceUri` in this codebase's normalization.
 */
function readUiResourceUri(
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  const ui = toolMeta?.["ui"];
  if (ui && typeof ui === "object") {
    const uri = (ui as { resourceUri?: unknown }).resourceUri;
    if (typeof uri === "string" && uri.length > 0) return uri;
  }
  return null;
}

function hasInlineUiResource(toolResult: unknown): boolean {
  const direct = (toolResult as { resource?: { uri?: unknown } } | null)
    ?.resource;
  if (typeof direct?.uri === "string" && direct.uri.startsWith("ui://")) {
    return true;
  }
  const content = (toolResult as { content?: unknown[] } | null)?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const uri = (item as { resource?: { uri?: unknown } } | null)?.resource
        ?.uri;
      if (typeof uri === "string" && uri.startsWith("ui://")) return true;
    }
  }
  return false;
}

export function detectUIType(
  toolMeta: Record<string, unknown> | undefined,
  toolResult: unknown,
): UIType | null {
  const hasTemplate = Boolean(toolMeta?.["openai/outputTemplate"]);
  const hasResource = readUiResourceUri(toolMeta) !== null;

  if (hasTemplate && hasResource) return UIType.OPENAI_SDK_AND_MCP_APPS;
  if (hasTemplate) return UIType.OPENAI_SDK;
  if (hasResource) return UIType.MCP_APPS;
  if (hasInlineUiResource(toolResult)) return UIType.MCP_UI;
  return null;
}

export function getUIResourceUri(
  uiType: UIType | null,
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  switch (uiType) {
    case UIType.MCP_APPS:
    case UIType.OPENAI_SDK_AND_MCP_APPS:
      return readUiResourceUri(toolMeta);
    case UIType.OPENAI_SDK:
      return (toolMeta?.["openai/outputTemplate"] as string) ?? null;
    default:
      return null;
  }
}

/**
 * Tools that render an interactive widget surface. Mirrors the inspector's
 * `shouldRenderWidget` gate (MCP_UI legacy inline rendering was removed during
 * the renderer consolidation, so it is intentionally excluded).
 */
export function isWidgetUiType(uiType: UIType | null): boolean {
  return (
    uiType === UIType.MCP_APPS ||
    uiType === UIType.OPENAI_SDK ||
    uiType === UIType.OPENAI_SDK_AND_MCP_APPS
  );
}
