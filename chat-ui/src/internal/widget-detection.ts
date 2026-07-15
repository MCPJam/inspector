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

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * MCP Apps (SEP-1865) / OpenAI Apps SDK templates surface the widget resource
 * under `_meta`. Producers use a flat slash key (`ui/resourceUri`, mirroring
 * `openai/outputTemplate`), a flat dot key (`ui.resourceUri`), or a nested
 * object (`ui: { resourceUri }`). Read all three so detection never silently
 * misses a widget-bearing tool.
 */
function readUiResourceUri(
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  if (!toolMeta) return null;
  const flat =
    asNonEmptyString(toolMeta["ui/resourceUri"]) ??
    asNonEmptyString(toolMeta["ui.resourceUri"]);
  if (flat) return flat;
  const ui = toolMeta["ui"];
  if (ui && typeof ui === "object") {
    return asNonEmptyString((ui as { resourceUri?: unknown }).resourceUri);
  }
  return null;
}

function readOpenAiOutputTemplate(
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  return asNonEmptyString(toolMeta?.["openai/outputTemplate"]);
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
  const hasTemplate = readOpenAiOutputTemplate(toolMeta) !== null;
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
      return readOpenAiOutputTemplate(toolMeta);
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
