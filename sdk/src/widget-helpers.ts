/**
 * Widget helpers for injecting the OpenAI compatibility runtime into MCP App HTML.
 * These are pure-string functions with zero external dependencies, copied from
 * mcpjam-inspector/server/utils/widget-helpers.ts so the SDK can prepare HTML
 * at capture time without depending on the server.
 */

import { MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT } from "./McpAppsOpenAICompatibleRuntime.bundled.js";

// ── Serialization ────────────────────────────────────────────────────

/**
 * Escape characters that could break inline <script> content.
 */
export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ── MCP Apps OpenAI compat injection ─────────────────────────────────

/**
 * Inject the OpenAI compatibility runtime into MCP App HTML.
 * Adds a JSON config element + the bundled IIFE script into <head>.
 * If no <head> tag exists, wraps the content in a full HTML document.
 *
 * Idempotent: if the config script is already present, returns the HTML unchanged.
 */
export function injectOpenAICompat(
  html: string,
  widgetData: {
    toolId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput: unknown;
    theme?: string;
    viewMode?: string;
    viewParams?: Record<string, unknown>;
  },
): string {
  if (html.includes('id="openai-compat-config"')) {
    return html;
  }

  const configJson = serializeForInlineScript({
    toolId: widgetData.toolId,
    toolName: widgetData.toolName,
    toolInput: widgetData.toolInput,
    toolOutput: widgetData.toolOutput,
    theme: widgetData.theme ?? "dark",
    viewMode: widgetData.viewMode ?? "inline",
    viewParams: widgetData.viewParams ?? {},
  });

  const configScript = `<script type="application/json" id="openai-compat-config">${configJson}</script>`;
  const escapedRuntime = MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT.replace(
    /<\//g,
    "<\\/",
  );
  const runtimeScript = `<script>${escapedRuntime}</script>`;
  const headContent = `${configScript}${runtimeScript}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${headContent}`);
  }
  return `<!DOCTYPE html><html><head>${headContent}<meta charset="UTF-8"></head><body>${html}</body></html>`;
}
