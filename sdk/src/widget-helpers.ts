/**
 * Widget helpers for injecting the shared widget runtimes into HTML.
 * These are pure-string functions with zero server-framework dependencies so
 * the SDK, inspector, and CLI can all prepare identical app payloads.
 */

import { MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT } from "./McpAppsOpenAICompatibleRuntime.bundled.js";
import { CHATGPT_APPS_RUNTIME_SCRIPT } from "./ChatGptAppsRuntime.bundled.js";

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
 * Per-method `window.openai.*` capability surface for the compat
 * runtime. Mirror of `ResolvedOpenAiAppsCapabilities` in the inspector
 * client (`client/src/lib/client-styles/types.ts`). Defined inline here
 * because the SDK can't import client types.
 *
 * Optional fields here mean "use the runtime's default" — the runtime's
 * default is the full ChatGPT surface, preserving the pre-capability
 * behavior for legacy callers that don't pass `capabilities`.
 */
export type OpenAiCompatCapabilities = {
  callTool?: boolean;
  sendFollowUpMessage?: boolean;
  setWidgetState?: boolean;
  requestDisplayMode?: "all" | "fullscreen-only" | "none";
  notifyIntrinsicHeight?: boolean;
  openExternal?: boolean;
  setOpenInAppUrl?: boolean;
  requestModal?: boolean;
  uploadFile?: boolean;
  selectFiles?: boolean;
  getFileDownloadUrl?: boolean;
  requestCheckout?: boolean;
  requestClose?: boolean;
};

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
    /**
     * Tool response `_meta` exposed to the widget as
     * `window.openai.toolResponseMetadata`. Apps SDK widgets read this
     * for non-model-context metadata (timestamps, source IDs, etc.).
     */
    toolResponseMetadata?: Record<string, unknown> | null;
    /**
     * Persisted widget state from a saved view or fork. The compat
     * runtime uses this as the initial value for `window.openai.widgetState`
     * so widgets boot in the same state they were when the view was
     * saved (Apps SDK parity).
     */
    initialWidgetState?: unknown;
    theme?: string;
    viewMode?: string;
    viewParams?: Record<string, unknown>;
    /**
     * Per-method capability surface the runtime should expose on
     * `window.openai`. Disabled methods are LITERALLY ABSENT from the
     * runtime (typeof === "undefined") so widgets that feature-detect
     * fall back correctly. When omitted, the runtime defaults to the
     * full ChatGPT surface — preserves behavior for callers that
     * pre-date the capability matrix.
     */
    capabilities?: OpenAiCompatCapabilities;
  }
): string {
  if (html.includes('id="openai-compat-config"')) {
    return html;
  }

  const configJson = serializeForInlineScript({
    toolId: widgetData.toolId,
    toolName: widgetData.toolName,
    toolInput: widgetData.toolInput,
    toolOutput: widgetData.toolOutput,
    toolResponseMetadata: widgetData.toolResponseMetadata ?? null,
    initialWidgetState: widgetData.initialWidgetState ?? null,
    theme: widgetData.theme ?? "dark",
    viewMode: widgetData.viewMode ?? "inline",
    viewParams: widgetData.viewParams ?? {},
    // Omit the field entirely when undefined so the runtime takes its
    // legacy full-surface default — keeps the serialized config
    // byte-identical to the pre-capability shape for old callers.
    ...(widgetData.capabilities !== undefined
      ? { capabilities: widgetData.capabilities }
      : {}),
  });

  const configScript = `<script type="application/json" id="openai-compat-config">${configJson}</script>`;
  const escapedRuntime = MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT.replace(
    /<\//g,
    "<\\/"
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

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function uniqueSources(values: string[]): string[] {
  return Array.from(new Set(values));
}

function hasAnyWidgetCspField(value: WidgetCspMeta): boolean {
  return (
    Boolean(value.connect_domains?.length) ||
    Boolean(value.resource_domains?.length) ||
    Boolean(value.frame_domains?.length)
  );
}

function normalizeStandardWidgetCsp(
  uiCsp: Record<string, unknown>,
): WidgetCspMeta | undefined {
  const normalized: WidgetCspMeta = {};
  const connectDomains = readStringArray(uiCsp.connectDomains);
  const resourceDomains = readStringArray(uiCsp.resourceDomains);
  const frameDomains = readStringArray(uiCsp.frameDomains);

  if (connectDomains) normalized.connect_domains = connectDomains;
  if (resourceDomains) normalized.resource_domains = resourceDomains;
  if (frameDomains) normalized.frame_domains = frameDomains;

  return hasAnyWidgetCspField(normalized) ? normalized : undefined;
}

function normalizeLegacyWidgetCsp(
  openaiCsp: Record<string, unknown>,
): WidgetCspMeta | undefined {
  const normalized: WidgetCspMeta = {};
  const connectDomains = readStringArray(openaiCsp.connect_domains);
  const resourceDomains = readStringArray(openaiCsp.resource_domains);
  const frameDomains = readStringArray(openaiCsp.frame_domains);

  if (connectDomains) normalized.connect_domains = connectDomains;
  if (resourceDomains) normalized.resource_domains = resourceDomains;
  if (frameDomains) normalized.frame_domains = frameDomains;

  return hasAnyWidgetCspField(normalized) ? normalized : undefined;
}

export function normalizeWidgetCspMeta(
  resourceMeta?: Record<string, unknown> | null,
): WidgetCspMeta | undefined {
  if (!resourceMeta || typeof resourceMeta !== "object") return undefined;

  const uiMeta =
    resourceMeta.ui && typeof resourceMeta.ui === "object"
      ? (resourceMeta.ui as Record<string, unknown>)
      : undefined;
  const uiCsp =
    uiMeta?.csp && typeof uiMeta.csp === "object"
      ? (uiMeta.csp as Record<string, unknown>)
      : undefined;
  if (uiCsp) return normalizeStandardWidgetCsp(uiCsp);

  const openaiCsp =
    resourceMeta["openai/widgetCSP"] &&
    typeof resourceMeta["openai/widgetCSP"] === "object"
      ? (resourceMeta["openai/widgetCSP"] as Record<string, unknown>)
      : undefined;

  return openaiCsp ? normalizeLegacyWidgetCsp(openaiCsp) : undefined;
}

export function buildCspHeader(
  mode: CspMode,
  widgetCsp?: WidgetCspMeta | null,
  options?: { frameAncestors?: string },
): CspConfig {
  let connectDomains: string[];
  let resourceDomains: string[];
  let frameDomains: string[];

  if (mode === "widget-declared") {
    connectDomains = uniqueSources([
      "'self'",
      ...(widgetCsp?.connect_domains || []),
      ...LOCALHOST_SOURCES,
      ...WS_SOURCES,
    ]);
    resourceDomains = uniqueSources([
      "'self'",
      "data:",
      "blob:",
      ...(widgetCsp?.resource_domains || []),
      ...LOCALHOST_SOURCES,
    ]);
    frameDomains =
      widgetCsp?.frame_domains && widgetCsp.frame_domains.length > 0
        ? uniqueSources(widgetCsp.frame_domains)
        : [];
  } else {
    connectDomains = uniqueSources([
      "'self'",
      "https:",
      "http:",
      "wss:",
      "ws:",
      ...LOCALHOST_SOURCES,
      ...WS_SOURCES,
    ]);
    resourceDomains = uniqueSources([
      "'self'",
      "data:",
      "blob:",
      "https:",
      "http:",
      ...LOCALHOST_SOURCES,
    ]);
    frameDomains = uniqueSources([
      "*",
      "data:",
      "blob:",
      "https:",
      "http:",
      "about:",
    ]);
  }

  const connectSrc = connectDomains.join(" ");
  const scriptSrc = uniqueSources([
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    ...resourceDomains,
  ]).join(" ");
  const styleSrc = uniqueSources([
    "'self'",
    "'unsafe-inline'",
    ...resourceDomains,
  ]).join(" ");
  const fontSrc = uniqueSources(["'self'", "data:", ...resourceDomains]).join(
    " ",
  );
  const imgSrc = uniqueSources(
    mode === "widget-declared"
      ? [
          "'self'",
          "data:",
          "blob:",
          ...(widgetCsp?.resource_domains || []),
          ...LOCALHOST_SOURCES,
        ]
      : ["'self'", "data:", "blob:", "https:", "http:", ...LOCALHOST_SOURCES],
  ).join(" ");
  const mediaSrc = uniqueSources(
    mode === "widget-declared"
      ? [
          "'self'",
          "data:",
          "blob:",
          ...(widgetCsp?.resource_domains || []),
          ...LOCALHOST_SOURCES,
        ]
      : ["'self'", "data:", "blob:", "https:", "http:"],
  ).join(" ");

  const frameAncestors =
    options?.frameAncestors ??
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*";

  const frameSrc =
    frameDomains.length > 0
      ? `frame-src ${frameDomains.join(" ")}`
      : "frame-src 'none'";

  const headerString = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    `font-src ${fontSrc}`,
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

export function buildCspMetaContent(headerString: string): string {
  return headerString
    .split(";")
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive.length > 0 &&
        !directive.startsWith("frame-ancestors") &&
        !directive.startsWith("report-uri") &&
        !directive.startsWith("sandbox"),
    )
    .join("; ");
}

// ── ChatGPT Apps runtime head builder ────────────────────────────────

export function buildChatGptRuntimeHead(options: {
  htmlContent: string;
  runtimeConfig: Record<string, unknown>;
  baseHref?: string;
  includeUrlPolyfill?: boolean;
}): string {
  const baseUrl = options.baseHref ?? extractBaseUrl(options.htmlContent);
  const shouldIncludeUrlPolyfill =
    options.includeUrlPolyfill ?? options.baseHref === undefined;
  return (
    `${WIDGET_BASE_CSS}` +
    `${shouldIncludeUrlPolyfill ? generateUrlPolyfillScript(baseUrl) : ""}` +
    `${baseUrl ? `<base href="${baseUrl}">` : ""}` +
    `${buildRuntimeConfigScript(options.runtimeConfig)}` +
    `<script>${CHATGPT_APPS_RUNTIME_SCRIPT}</script>`
  );
}
