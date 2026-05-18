export {
  serializeForInlineScript,
  injectOpenAICompat,
  extractBaseUrl,
  generateUrlPolyfillScript,
  WIDGET_BASE_CSS,
  buildRuntimeConfigScript,
  injectScripts,
  buildCspHeader,
  buildCspMetaContent,
  buildChatGptRuntimeHead,
} from "@mcpjam/sdk";
import type { WidgetCspMeta } from "@mcpjam/sdk";
export type { CspMode, WidgetCspMeta, CspConfig } from "@mcpjam/sdk";

// Reads CSP from MCP Apps' standard `_meta.ui.csp` (camelCase) and falls
// back to legacy `_meta["openai/widgetCSP"]` (snake_case). Output matches
// the snake_case shape consumed by buildCspHeader.
export function normalizeWidgetCspMeta(
  resourceMeta: Record<string, unknown> | undefined,
): WidgetCspMeta | undefined {
  if (!resourceMeta) return undefined;

  const ui = resourceMeta.ui as
    | { csp?: Record<string, unknown> }
    | undefined;
  const standard = ui?.csp;
  if (standard && typeof standard === "object") {
    const connect = standard.connectDomains ?? standard.connect_domains;
    const resource = standard.resourceDomains ?? standard.resource_domains;
    const frame = standard.frameDomains ?? standard.frame_domains;
    if (
      Array.isArray(connect) ||
      Array.isArray(resource) ||
      Array.isArray(frame)
    ) {
      return {
        connect_domains: Array.isArray(connect)
          ? (connect as string[])
          : undefined,
        resource_domains: Array.isArray(resource)
          ? (resource as string[])
          : undefined,
        frame_domains: Array.isArray(frame) ? (frame as string[]) : undefined,
      };
    }
  }

  const legacy = resourceMeta["openai/widgetCSP"];
  if (legacy && typeof legacy === "object") {
    return legacy as WidgetCspMeta;
  }
  return undefined;
}
