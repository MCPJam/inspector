import { detectUIType, UIType } from "./ui-detection.js";
import type { WidgetUsage } from "./widget-scan.js";
import type { ConnectionFacts, ServerRequirements } from "./types.js";

/**
 * Minimal tool shape the requirement derivation needs — a name plus the
 * optional `_meta` bag. Structural so callers can pass an MCP `ListToolsResult`
 * tool directly.
 */
export interface HostCompatTool {
  name: string;
  _meta?: Record<string, unknown>;
}

/**
 * Tools input for `deriveServerRequirements`. `toolsMetadata` mirrors the
 * inspector's connect-time metadata map (tool name → `_meta`); when present it
 * wins over an inline `tool._meta`.
 */
export interface HostCompatToolsInput {
  tools: HostCompatTool[];
  toolsMetadata?: Record<string, Record<string, unknown>>;
}

/** A tool is app-only when its `_meta.ui.visibility` excludes `"model"`. */
function isAppOnlyTool(meta: Record<string, unknown> | undefined): boolean {
  const ui = meta?.ui as { visibility?: unknown } | undefined;
  const visibility = ui?.visibility;
  return Array.isArray(visibility) && !visibility.includes("model");
}

/**
 * Derive what a server demands of a host from its tools list (apps lane) +
 * optional widget-usage scan (L1) + connection facts (server lane). Pure — the
 * caller supplies the inputs (inspector hook, CLI, or API all gather them their
 * own way).
 */
export function deriveServerRequirements(
  toolsData?: HostCompatToolsInput | null,
  widgetUsage?: WidgetUsage,
  connectionFacts?: ConnectionFacts,
): ServerRequirements {
  const unknownDimensions: string[] = [];

  if (!toolsData?.tools) {
    unknownDimensions.push("widget usage (tools metadata not loaded)");
    return {
      widgets: { mcpAppsOnly: [], openaiAppsOnly: [], dual: [] },
      appOnlyWidgets: [],
      hasWidgets: false,
      widgetUsage,
      connectionFacts,
      unknownDimensions,
    };
  }

  const mcpAppsOnly: string[] = [];
  const openaiAppsOnly: string[] = [];
  const dual: string[] = [];
  const appOnlyWidgets: string[] = [];

  for (const tool of toolsData.tools) {
    const meta =
      toolsData.toolsMetadata?.[tool.name] ??
      (tool._meta as Record<string, unknown> | undefined);
    let isWidget = true;
    switch (detectUIType(meta, undefined)) {
      case UIType.MCP_APPS:
        mcpAppsOnly.push(tool.name);
        break;
      case UIType.OPENAI_SDK:
        openaiAppsOnly.push(tool.name);
        break;
      case UIType.OPENAI_SDK_AND_MCP_APPS:
        dual.push(tool.name);
        break;
      default:
        isWidget = false;
        break;
    }
    if (isWidget && isAppOnlyTool(meta)) appOnlyWidgets.push(tool.name);
  }

  const hasWidgets =
    mcpAppsOnly.length + openaiAppsOnly.length + dual.length > 0;

  // A widget server whose widgets haven't been conclusively scanned (scan
  // pending, or every `resources/read` failed) must read as Unknown, not a
  // false Works — we can't claim "no capability gaps" without analyzing the
  // HTML. `{}` IS conclusive (scanned, clean); `undefined` is not.
  if (hasWidgets && !widgetUsage) {
    unknownDimensions.push("widget capabilities (widget HTML not analyzed)");
  }

  return {
    widgets: { mcpAppsOnly, openaiAppsOnly, dual },
    appOnlyWidgets,
    hasWidgets,
    widgetUsage,
    connectionFacts,
    unknownDimensions,
  };
}
