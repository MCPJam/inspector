/**
 * Shared widget helpers for MCP Apps and ChatGPT Apps rendering.
 * Used by local app routes and hosted web routes.
 */

import { CHATGPT_APPS_RUNTIME_SCRIPT } from "../routes/apps/chatgpt-apps/OpenAIRuntime.bundled.js";
import { MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT } from "../routes/apps/mcp-apps/McpAppsOpenAICompatibleRuntime.bundled.js";

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

// ── URL / base helpers ───────────────────────────────────────────────

export function extractBaseUrl(html: string): string {
  const baseMatch = html.match(/<base\s+href\s*=\s*["']([^"']+)["']\s*\/?>/i);
  if (baseMatch) return baseMatch[1];
  const innerMatch = html.match(/window\.innerBaseUrl\s*=\s*["']([^"']+)["']/);
  if (innerMatch) return innerMatch[1];
  return "";
}

export function generateUrlPolyfillScript(baseUrl: string): string {
  if (!baseUrl) return "";
  return `<script>(function(){
var BASE="${baseUrl}";window.__widgetBaseUrl=BASE;var OrigURL=window.URL;
function isRelative(u){return typeof u==="string"&&!u.match(/^[a-z][a-z0-9+.-]*:/i);}
window.URL=function URL(u,b){
var base=b;if(base===void 0||base===null||base==="null"||base==="about:srcdoc"){base=BASE;}
else if(typeof base==="string"&&base.startsWith("null")){base=BASE;}
try{return new OrigURL(u,base);}catch(e){if(isRelative(u)){try{return new OrigURL(u,BASE);}catch(e2){}}throw e;}
};
window.URL.prototype=OrigURL.prototype;window.URL.createObjectURL=OrigURL.createObjectURL;
window.URL.revokeObjectURL=OrigURL.revokeObjectURL;window.URL.canParse=OrigURL.canParse;
})();</script>`;
}

// ── CSS / script injection ───────────────────────────────────────────

export const WIDGET_BASE_CSS = `<style>
html, body {
  margin: 0;
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
</style>`;

const CONFIG_SCRIPT_ID = "openai-runtime-config";

export function buildRuntimeConfigScript(
  config: Record<string, unknown>,
): string {
  return `<script type="application/json" id="${CONFIG_SCRIPT_ID}">${serializeForInlineScript(config)}</script>`;
}

export function injectScripts(html: string, headContent: string): string {
  if (/<html[^>]*>/i.test(html) && /<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${headContent}`);
  }
  return `<!DOCTYPE html><html><head>${headContent}<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body>${html}</body></html>`;
}

// ── CSP ──────────────────────────────────────────────────────────────

export type CspMode = "permissive" | "widget-declared";

export interface WidgetCspMeta {
  connect_domains?: string[];
  resource_domains?: string[];
  frame_domains?: string[];
}

export interface CspConfig {
  mode: CspMode;
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  headerString: string;
}

const LOCALHOST_SOURCES = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*",
];

const WS_SOURCES = [
  "ws://localhost:*",
  "ws://127.0.0.1:*",
  "wss://localhost:*",
];

/**
 * Build CSP header string based on mode and widget metadata.
 *
 * @param mode - CSP enforcement mode
 * @param widgetCsp - Widget's declared CSP from openai/widgetCSP metadata
 * @param options.frameAncestors - Override for the frame-ancestors directive.
 *   When omitted, defaults to the local-mode value (self + localhost).
 *   Hosted mode passes its own value via `buildFrameAncestors()`.
 */
export function buildCspHeader(
  mode: CspMode,
  widgetCsp?: WidgetCspMeta | null,
  options?: { frameAncestors?: string },
): CspConfig {
  let connectDomains: string[];
  let resourceDomains: string[];
  let frameDomains: string[];

  if (mode === "widget-declared") {
    connectDomains = [
      "'self'",
      ...(widgetCsp?.connect_domains || []),
      ...LOCALHOST_SOURCES,
      ...WS_SOURCES,
    ];
    resourceDomains = [
      "'self'",
      "data:",
      "blob:",
      ...(widgetCsp?.resource_domains || []),
      ...LOCALHOST_SOURCES,
    ];
    frameDomains =
      widgetCsp?.frame_domains && widgetCsp.frame_domains.length > 0
        ? widgetCsp.frame_domains
        : [];
  } else {
    connectDomains = [
      "'self'",
      "https:",
      "wss:",
      "ws:",
      ...LOCALHOST_SOURCES,
      ...WS_SOURCES,
    ];
    resourceDomains = [
      "'self'",
      "data:",
      "blob:",
      "https:",
      ...LOCALHOST_SOURCES,
    ];
    frameDomains = ["*", "data:", "blob:", "https:", "http:", "about:"];
  }

  const connectSrc = connectDomains.join(" ");
  const resourceSrc = resourceDomains.join(" ");
  const imgSrc =
    mode === "widget-declared"
      ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${LOCALHOST_SOURCES.join(" ")}`
      : `'self' data: blob: https: ${LOCALHOST_SOURCES.join(" ")}`;
  const mediaSrc =
    mode === "widget-declared"
      ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${LOCALHOST_SOURCES.join(" ")}`
      : "'self' data: blob: https:";

  const frameAncestors =
    options?.frameAncestors ??
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*";

  const frameSrc =
    frameDomains.length > 0
      ? `frame-src ${frameDomains.join(" ")}`
      : "frame-src 'none'";

  const headerString = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${resourceSrc}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    `style-src 'self' 'unsafe-inline' ${resourceSrc}`,
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    `font-src 'self' data: ${resourceSrc}`,
    `connect-src ${connectSrc}`,
    frameSrc,
    frameAncestors,
  ].join("; ");

  return {
    mode,
    connectDomains,
    resourceDomains,
    frameDomains,
    headerString,
  };
}

// ── ChatGPT Apps runtime head builder ────────────────────────────────

export function buildChatGptRuntimeHead(options: {
  htmlContent: string;
  runtimeConfig: Record<string, unknown>;
}): string {
  const baseUrl = extractBaseUrl(options.htmlContent);
  return (
    `${WIDGET_BASE_CSS}` +
    `${generateUrlPolyfillScript(baseUrl)}` +
    `${baseUrl ? `<base href="${baseUrl}">` : ""}` +
    `${buildRuntimeConfigScript(options.runtimeConfig)}` +
    `<script>${CHATGPT_APPS_RUNTIME_SCRIPT}</script>`
  );
}
