import { Hono } from "hono";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { API_RUNTIME_SCRIPT } from "./chatgpt.bundled";
import "../../types/hono";
import { logger } from "../../utils/logger";

const chatgpt = new Hono();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Shared Types & Storage
// ============================================================================

interface UserLocation {
  country: string;
  region: string;
  city: string;
}

interface DeviceCapabilities {
  hover: boolean;
  touch: boolean;
}

interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface WidgetData {
  serverId: string;
  uri: string;
  toolInput: Record<string, any>;
  toolOutput: any;
  toolResponseMetadata?: Record<string, any> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  locale?: string; // BCP 47 locale from host (e.g., 'en-US')
  deviceType?: "mobile" | "tablet" | "desktop";
  userLocation?: UserLocation | null; // Coarse IP-based location per SDK spec
  maxHeight?: number | null; // ChatGPT provides maxHeight constraint for inline mode
  cspMode?: CspMode; // CSP enforcement mode
  capabilities?: DeviceCapabilities; // Device capabilities (hover, touch)
  safeAreaInsets?: SafeAreaInsets; // Safe area insets for device notches, etc.
  timestamp: number;
}

const widgetDataStore = new Map<string, WidgetData>();

// Cleanup expired widget data every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [toolId, data] of widgetDataStore.entries()) {
      if (now - data.timestamp > ONE_HOUR) {
        widgetDataStore.delete(toolId);
      }
    }
  },
  5 * 60 * 1000,
).unref();

// ============================================================================
// Shared Helpers (DRY)
// ============================================================================

const serializeForInlineScript = (value: unknown) =>
  JSON.stringify(value ?? null)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

function extractHtmlContent(content: unknown): {
  html: string;
  firstContent: any;
} {
  let html = "";
  const contentsArray = Array.isArray((content as any)?.contents)
    ? (content as any).contents
    : [];
  const firstContent = contentsArray[0];

  if (firstContent) {
    if (typeof firstContent.text === "string") html = firstContent.text;
    else if (typeof firstContent.blob === "string") html = firstContent.blob;
  }
  if (!html && content && typeof content === "object") {
    const rc = content as Record<string, unknown>;
    if (typeof rc.text === "string") html = rc.text;
    else if (typeof rc.blob === "string") html = rc.blob;
  }
  return { html, firstContent };
}

function resolveServerId(
  serverId: string,
  availableServers: string[],
): { id: string; error?: string } {
  if (availableServers.includes(serverId)) return { id: serverId };
  const match = availableServers.find(
    (n) => n.toLowerCase() === serverId.toLowerCase(),
  );
  if (match) return { id: match };
  return {
    id: serverId,
    error: `Server not connected. Requested: ${serverId}, Available: ${availableServers.join(", ")}`,
  };
}

function extractBaseUrl(html: string): string {
  const baseMatch = html.match(/<base\s+href\s*=\s*["']([^"']+)["']\s*\/?>/i);
  if (baseMatch) return baseMatch[1];
  const innerMatch = html.match(/window\.innerBaseUrl\s*=\s*["']([^"']+)["']/);
  if (innerMatch) return innerMatch[1];
  return "";
}

interface RuntimeConfig {
  toolId: string;
  toolName: string;
  toolInput: Record<string, any>;
  toolOutput: any;
  toolResponseMetadata?: Record<string, any> | null;
  theme: string;
  locale: string; // Host-controlled BCP 47 locale (e.g., 'en-US')
  deviceType: "mobile" | "tablet" | "desktop"; // Host-controlled device type
  userLocation?: UserLocation | null; // Coarse IP-based location per SDK spec
  maxHeight?: number | null; // Host-controlled max height constraint (ChatGPT uses ~500px for inline)
  capabilities?: DeviceCapabilities; // Host-controlled device capabilities
  safeAreaInsets?: SafeAreaInsets; // Host-controlled safe area insets
  viewMode?: string;
  viewParams?: Record<string, any>;
  useMapPendingCalls?: boolean;
}

function generateUrlPolyfillScript(baseUrl: string): string {
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

// Widget base styles: keep layout clean but allow vertical scrolling when the host
// uses a fixed-height container (fullscreen/PiP). Inline mode still auto-resizes,
// so scrollbars typically remain hidden while staying available when needed.
const WIDGET_BASE_CSS = `<style>
html, body {
  margin: 0;
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
</style>`;

const CONFIG_SCRIPT_ID = "openai-runtime-config";

function buildConfigScript(config: RuntimeConfig): string {
  return `<script type="application/json" id="${CONFIG_SCRIPT_ID}">${serializeForInlineScript(config)}</script>`;
}

function buildRuntimeHeadContent(options: {
  runtimeConfig: RuntimeConfig;
  urlPolyfill?: string;
  baseTag?: string;
}): string {
  const configScript = buildConfigScript(options.runtimeConfig);
  const runtimeScript = `<script>${API_RUNTIME_SCRIPT}</script>`;
  return `${WIDGET_BASE_CSS}${options.urlPolyfill ?? ""}${options.baseTag ?? ""}${configScript}${runtimeScript}`;
}

function injectScripts(html: string, headContent: string): string {
  if (/<html[^>]*>/i.test(html) && /<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${headContent}`);
  }
  return `<!DOCTYPE html><html><head>${headContent}<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body>${html}</body></html>`;
}

// ============================================================================
// CSP Configuration
// ============================================================================

/**
 * CSP mode types
 */
type CspMode = "permissive" | "widget-declared";

/**
 * Widget CSP metadata from openai/widgetCSP
 */
interface WidgetCspMeta {
  connect_domains?: string[];
  resource_domains?: string[];
  frame_domains?: string[];
}

/**
 * Parsed CSP configuration for client display
 */
interface CspConfig {
  mode: CspMode;
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  headerString: string;
}

/**
 * Build CSP header string based on mode and widget metadata.
 *
 * @param mode - CSP enforcement mode
 * @param widgetCsp - Widget's declared CSP from openai/widgetCSP metadata
 * @returns CSP configuration including header string and parsed domains
 */
function buildCspHeader(
  mode: CspMode,
  widgetCsp?: WidgetCspMeta | null,
): CspConfig {
  // Always allow localhost/127.* for widget development + sandbox proxy HMR
  const localhostSources = [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "https://localhost:*",
    "https://127.0.0.1:*",
  ];

  // WebSocket sources for HMR, etc.
  const wsSources = [
    "ws://localhost:*",
    "ws://127.0.0.1:*",
    "wss://localhost:*",
  ];

  let connectDomains: string[];
  let resourceDomains: string[];
  let frameDomains: string[];

  switch (mode) {
    case "permissive":
      // Most lenient - allow https: wildcard
      connectDomains = [
        "'self'",
        "https:",
        "wss:",
        "ws:",
        ...localhostSources,
        ...wsSources,
      ];
      resourceDomains = [
        "'self'",
        "data:",
        "blob:",
        "https:",
        ...localhostSources,
      ];
      frameDomains = ["*", "data:", "blob:", "https:", "http:", "about:"];
      break;

    case "widget-declared":
      // Honor widget's declared CSP, with sensible defaults
      connectDomains = [
        "'self'",
        ...(widgetCsp?.connect_domains || []),
        ...localhostSources,
        ...wsSources,
      ];
      resourceDomains = [
        "'self'",
        "data:",
        "blob:",
        ...(widgetCsp?.resource_domains || []),
        ...localhostSources,
      ];
      frameDomains =
        widgetCsp?.frame_domains && widgetCsp.frame_domains.length > 0
          ? widgetCsp.frame_domains
          : [];
      break;

    default:
      // Fallback to permissive
      connectDomains = ["'self'", "https:", ...localhostSources];
      resourceDomains = [
        "'self'",
        "data:",
        "blob:",
        "https:",
        ...localhostSources,
      ];
      frameDomains = ["*", "data:", "blob:", "https:", "http:", "about:"];
  }

  const connectSrc = connectDomains.join(" ");
  const resourceSrc = resourceDomains.join(" ");

  // Image/media sources - respect mode for widget-declared CSP
  // In permissive mode: allow all https: sources
  // In widget-declared mode: only allow declared resource_domains
  const imgSrc =
    mode === "widget-declared"
      ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${localhostSources.join(" ")}`
      : `'self' data: blob: https: ${localhostSources.join(" ")}`;

  const mediaSrc =
    mode === "widget-declared"
      ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${localhostSources.join(" ")}`
      : "'self' data: blob: https:";

  // Frame ancestors must always include localhost/127.0.0.1 for the cross-origin
  // sandbox architecture to work (sandbox-proxy swaps localhost <-> 127.0.0.1)
  // This is required regardless of NODE_ENV since the inspector is self-hosted
  const frameAncestors =
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*";

  // frame-src directive: controls which origins can be loaded in iframes
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

// ============================================================================
// Routes
// ============================================================================

chatgpt.post("/widget/store", async (c) => {
  try {
    const {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      toolId,
      toolName,
      theme,
      locale,
      deviceType,
      userLocation,
      maxHeight,
      cspMode,
      capabilities,
      safeAreaInsets,
    } = await c.req.json();
    if (!serverId || !uri || !toolId || !toolName)
      return c.json({ success: false, error: "Missing required fields" }, 400);

    widgetDataStore.set(toolId, {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata: toolResponseMetadata ?? null,
      toolId,
      toolName,
      theme: theme ?? "dark",
      locale: locale ?? "en-US", // Host-controlled locale per SDK spec
      deviceType: deviceType ?? "desktop",
      userLocation: userLocation ?? null, // Coarse IP-based location per SDK spec
      maxHeight: maxHeight ?? null, // Host-controlled max height constraint
      cspMode: cspMode ?? "permissive", // CSP enforcement mode
      capabilities: capabilities ?? { hover: true, touch: false }, // Device capabilities
      safeAreaInsets: safeAreaInsets ?? {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      }, // Safe area insets
      timestamp: Date.now(),
    });
    return c.json({ success: true });
  } catch (error) {
    logger.error("Error storing widget data:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

chatgpt.get("/sandbox-proxy", (c) => {
  const html = readFileSync(
    join(__dirname, "chatgpt-sandbox-proxy.html"),
    "utf-8",
  );
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  // Allow cross-origin framing between localhost and 127.0.0.1 for triple-iframe architecture
  c.header(
    "Content-Security-Policy",
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  );
  // Remove X-Frame-Options as it doesn't support multiple origins (CSP takes precedence)
  return c.body(html);
});

chatgpt.get("/widget-html/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");
    const widgetData = widgetDataStore.get(toolId);
    if (!widgetData)
      return c.json({ error: "Widget data not found or expired" }, 404);

    const {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      toolName,
      theme,
      locale,
      deviceType,
      userLocation,
      maxHeight,
      cspMode,
      capabilities,
      safeAreaInsets,
    } = widgetData;
    const mcpClientManager = c.mcpClientManager;
    const availableServers = mcpClientManager
      .listServers()
      .filter((id) => Boolean(mcpClientManager.getClient(id)));

    const resolved = resolveServerId(serverId, availableServers);
    if (resolved.error) return c.json({ error: resolved.error }, 404);

    const content = await mcpClientManager.readResource(resolved.id, { uri });
    const { html: htmlContent, firstContent } = extractHtmlContent(content);
    if (!htmlContent) return c.json({ error: "No HTML content found" }, 404);

    // Extract openai/widgetCSP from resource metadata
    const resourceMeta = firstContent?._meta as
      | Record<string, unknown>
      | undefined;
    const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
      | WidgetCspMeta
      | undefined;

    // Build CSP configuration based on mode
    const cspConfig = buildCspHeader(cspMode ?? "permissive", widgetCspRaw);

    const baseUrl = extractBaseUrl(htmlContent);
    const runtimeConfig: RuntimeConfig = {
      toolId,
      toolName,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      theme: theme ?? "dark",
      locale: locale ?? "en-US",
      deviceType: deviceType ?? "desktop",
      userLocation: userLocation ?? null,
      maxHeight: maxHeight ?? null,
      capabilities: capabilities ?? undefined,
      safeAreaInsets: safeAreaInsets ?? undefined,
      viewMode: "inline",
      viewParams: {},
      useMapPendingCalls: true,
    };
    const modifiedHtml = injectScripts(
      htmlContent,
      buildRuntimeHeadContent({
        runtimeConfig,
        urlPolyfill: generateUrlPolyfillScript(baseUrl),
        baseTag: baseUrl ? `<base href="${baseUrl}">` : "",
      }),
    );

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({
      html: modifiedHtml,
      // Return full CSP config for client display
      csp: {
        mode: cspConfig.mode,
        connectDomains: cspConfig.connectDomains,
        resourceDomains: cspConfig.resourceDomains,
        frameDomains: cspConfig.frameDomains,
        headerString: cspConfig.headerString,
        // Also return the widget's declared CSP for reference
        widgetDeclared: widgetCspRaw ?? null,
      },
      widgetDescription: resourceMeta?.["openai/widgetDescription"] as
        | string
        | undefined,
      prefersBorder:
        (resourceMeta?.["openai/widgetPrefersBorder"] as boolean | undefined) ??
        true,
      closeWidget:
        (resourceMeta?.["openai/closeWidget"] as boolean | undefined) ?? false,
    });
  } catch (error) {
    logger.error("Error serving widget HTML:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

chatgpt.get("/widget/:toolId", async (c) => {
  const toolId = c.req.param("toolId");
  if (!widgetDataStore.get(toolId))
    return c.html(
      "<html><body>Error: Widget data not found or expired</body></html>",
      404,
    );

  return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Loading Widget...</title></head><body><script>
(async function() {
  const searchParams = window.location.search;
  history.replaceState(null, '', '/');
  const response = await fetch('/api/apps/chatgpt/widget-content/${toolId}' + searchParams);
  const html = await response.text();
  document.open(); document.write(html); document.close();
})();
</script></body></html>`);
});

chatgpt.get("/widget-content/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");
    const viewMode = c.req.query("view_mode") || "inline";

    // Read CSP mode from query param (allows override for testing)
    const cspModeParam = c.req.query("csp_mode") as CspMode | undefined;

    let viewParams = {};
    try {
      const vp = c.req.query("view_params");
      if (vp) viewParams = JSON.parse(vp);
    } catch (e) {}

    // Read optional template URI for modal views
    const templateUri = c.req.query("template");

    // Validate template URI if provided - must use ui:// protocol for security
    if (templateUri && !templateUri.startsWith("ui://")) {
      return c.html(
        "<html><body>Error: Template must use ui:// protocol</body></html>",
        400,
      );
    }

    const widgetData = widgetDataStore.get(toolId);
    if (!widgetData)
      return c.html(
        "<html><body>Error: Widget data not found or expired</body></html>",
        404,
      );

    const {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      toolName,
      theme,
      locale,
      deviceType,
      userLocation,
      maxHeight,
      cspMode: storedCspMode,
      capabilities,
      safeAreaInsets,
    } = widgetData;

    // Use query param override if provided, otherwise use stored mode
    const effectiveCspMode = cspModeParam ?? storedCspMode ?? "permissive";

    const mcpClientManager = c.mcpClientManager;
    const availableServers = mcpClientManager
      .listServers()
      .filter((id) => Boolean(mcpClientManager.getClient(id)));

    const resolved = resolveServerId(serverId, availableServers);
    if (resolved.error)
      return c.html(
        `<html><body><h3>Error: Server not connected</h3><p>${resolved.error}</p></body></html>`,
        404,
      );

    // Use template URI if provided, otherwise use the stored widget URI
    const resourceUri = templateUri || uri;
    const content = await mcpClientManager.readResource(resolved.id, {
      uri: resourceUri,
    });
    const { html: htmlContent, firstContent } = extractHtmlContent(content);
    if (!htmlContent)
      return c.html(
        "<html><body>Error: No HTML content found</body></html>",
        404,
      );

    // Extract openai/widgetCSP from resource metadata
    const resourceMeta = firstContent?._meta as
      | Record<string, unknown>
      | undefined;
    const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
      | WidgetCspMeta
      | undefined;

    // Build CSP based on effective mode
    const cspConfig = buildCspHeader(effectiveCspMode, widgetCspRaw);

    const runtimeConfig: RuntimeConfig = {
      toolId,
      toolName,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      theme: theme ?? "dark",
      locale: locale ?? "en-US",
      deviceType: deviceType ?? "desktop",
      userLocation: userLocation ?? null,
      maxHeight: maxHeight ?? null,
      capabilities: capabilities ?? undefined,
      safeAreaInsets: safeAreaInsets ?? undefined,
      viewMode,
      viewParams,
      useMapPendingCalls: false,
    };
    const modifiedHtml = injectScripts(
      htmlContent,
      buildRuntimeHeadContent({
        runtimeConfig,
        baseTag: '<base href="/">',
      }),
    );

    // Apply the built CSP header
    c.header("Content-Security-Policy", cspConfig.headerString);
    // Note: X-Frame-Options removed - CSP frame-ancestors handles this and
    // X-Frame-Options doesn't support multiple origins needed for cross-origin sandbox
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");

    return c.html(modifiedHtml);
  } catch (error) {
    logger.error("Error serving widget content:", error);
    return c.html(
      `<html><body>Error: ${error instanceof Error ? error.message : "Unknown error"}</body></html>`,
      500,
    );
  }
});

export default chatgpt;
