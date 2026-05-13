/**
 * OpenAI Apps SDK resource `_meta` helpers — shared between the hosted
 * (`/web/apps`) and local (`/apps/mcp-apps`) widget-content routes so
 * the snake_case → camelCase CSP translation can't drift between the
 * two deployments.
 *
 * OpenAI's `openai/widgetCSP` ships as snake_case (`connect_domains`,
 * `resource_domains`, `frame_domains`) per the OpenAI Apps SDK
 * envelope, while the MCP renderer + sandbox proxy read the camelCase
 * `McpUiResourceCsp` shape (`connectDomains`, `resourceDomains`,
 * `frameDomains`). Without translation, `cspMode: "widget-declared"`
 * silently drops the widget's declared external domains.
 */

import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * Translate an `openai/widgetCSP` blob (snake_case) into
 * `McpUiResourceCsp` (camelCase). Returns `undefined` when the input
 * is absent or carries no usable string domains.
 */
export function normalizeOpenAiWidgetCsp(
  rawCsp: unknown,
): McpUiResourceCsp | undefined {
  if (!rawCsp || typeof rawCsp !== "object") return undefined;
  const obj = rawCsp as {
    connect_domains?: unknown;
    resource_domains?: unknown;
    frame_domains?: unknown;
  };
  const connect = toStringArray(obj.connect_domains);
  const resource = toStringArray(obj.resource_domains);
  const frame = toStringArray(obj.frame_domains);
  if (!connect && !resource && !frame) return undefined;
  return {
    ...(connect ? { connectDomains: connect } : {}),
    ...(resource ? { resourceDomains: resource } : {}),
    ...(frame ? { frameDomains: frame } : {}),
  };
}

/**
 * Read OpenAI-flavored discovery metadata (CSP + prefersBorder) off a
 * resource `_meta` blob. Returns an object with the camelCase CSP and
 * the prefers-border boolean (or both `undefined` when the resource
 * carries no OpenAI metadata).
 */
export function readOpenAiDiscoveryMeta(
  rawMeta: Record<string, unknown> | undefined,
): {
  csp: McpUiResourceCsp | undefined;
  prefersBorder: boolean | undefined;
} {
  return {
    csp: normalizeOpenAiWidgetCsp(rawMeta?.["openai/widgetCSP"]),
    prefersBorder: rawMeta?.["openai/widgetPrefersBorder"] as
      | boolean
      | undefined,
  };
}
