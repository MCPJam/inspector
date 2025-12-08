import { Hono } from "hono";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "../../types/hono";

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

interface ApiScriptOptions {
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
  viewMode?: string;
  viewParams?: Record<string, any>;
  useMapPendingCalls?: boolean;
}

/**
 * Generate the OpenAI Apps SDK bridge script - SINGLE SOURCE OF TRUTH
 *
 * This implements the official OpenAI Apps SDK window.openai API with the following:
 *
 * === OFFICIAL SDK PROPERTIES (per https://developers.openai.com/apps-sdk/) ===
 * - toolOutput: object - Initial structuredContent from tool result
 * - toolInput: object - Original tool input arguments
 * - toolResponseMetadata: object - Response metadata from _meta (widget-only)
 * - widgetState: unknown - Current widget-scoped state snapshot
 * - displayMode: 'inline' | 'pip' | 'fullscreen' - Current display mode
 * - maxHeight: number | null - Maximum allowed height
 * - safeArea: { insets: { top, right, bottom, left } } - Layout safe area
 * - theme: 'light' | 'dark' - Current theme
 * - locale: string - BCP 47 locale (e.g., 'en-US')
 * - userAgent: { device: { type }, capabilities: { hover, touch } }
 *
 * === OFFICIAL SDK METHODS ===
 * - setWidgetState(state) - Persist widget state (sync call, async persistence)
 * - callTool(name, args) - Invoke MCP tool, returns Promise
 * - sendFollowUpMessage({ prompt }) - Insert message into chat
 * - requestDisplayMode({ mode }) - Request display mode change
 * - requestClose() - Programmatically close widget
 * - openExternal({ href }) - Open external URL in new tab
 *
 * === INSPECTOR-SPECIFIC EXTENSIONS (not in official SDK) ===
 * - requestModal({ title, params, anchor }) - Open widget in modal dialog
 * - notifyIntrinsicHeight(height) - Explicitly report content height
 * - sendFollowupTurn(message) - Alias for sendFollowUpMessage (deprecated)
 * - view: { mode, params } - Modal view parameters (Inspector extension)
 * - window.webplus - Alias for window.openai (Inspector compatibility)
 */
function generateApiScript(opts: ApiScriptOptions): string {
  const {
    toolId,
    toolName,
    toolInput,
    toolOutput,
    toolResponseMetadata,
    theme,
    locale,
    deviceType,
    userLocation,
    maxHeight,
    viewMode = "inline",
    viewParams = {},
    useMapPendingCalls = true,
  } = opts;

  const widgetStateKey = `openai-widget-state:${toolName}:${toolId}`;

  // Note: widgetAccessibleTools check removed for ChatGPT parity - ChatGPT doesn't enforce client-side
  const callToolImpl = useMapPendingCalls
    ? `callTool(toolName, args = {}) {
        const callId = ++this._callId;
        return new Promise((resolve, reject) => {
          this._pendingCalls.set(callId, { resolve, reject });
          window.parent.postMessage({ type: 'openai:callTool', toolName, args, callId, toolId: ${JSON.stringify(toolId)},
            // Client-supplied _meta per SDK spec
            _meta: Object.assign({
              'openai/locale': hostLocale,
              'openai/userAgent': navigator.userAgent,
              'openai/subject': getSubjectId()
            }, hostUserLocation ? { 'openai/userLocation': hostUserLocation } : {})
          }, '*');
          setTimeout(() => { if (this._pendingCalls.has(callId)) { this._pendingCalls.delete(callId); reject(new Error('Tool call timeout')); } }, 30000);
        });
      },`
    : `async callTool(toolName, args = {}) {
        const callId = ++this._callId;
        return new Promise((resolve, reject) => {
          const handler = (event) => {
            if (event.data.type === 'openai:callTool:response' && event.data.callId === callId) {
              window.removeEventListener('message', handler);
              event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
            }
          };
          window.addEventListener('message', handler);
          window.parent.postMessage({ type: 'openai:callTool', callId, toolName, args, toolId: ${JSON.stringify(toolId)},
            // Client-supplied _meta per SDK spec
            _meta: Object.assign({
              'openai/locale': hostLocale,
              'openai/userAgent': navigator.userAgent,
              'openai/subject': getSubjectId()
            }, hostUserLocation ? { 'openai/userLocation': hostUserLocation } : {})
          }, '*');
          setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('Tool call timeout')); }, 30000);
        });
      },`;

  const callToolResponseHandler = useMapPendingCalls
    ? `case 'openai:callTool:response': {
          const pending = window.openai._pendingCalls.get(callId);
          if (pending) { window.openai._pendingCalls.delete(callId); error ? pending.reject(new Error(error)) : pending.resolve(result); }
          break;
        }`
    : "";

  return `<script>
(function() {
  'use strict';
  // Host-controlled values per SDK spec (passed from Inspector, not computed in widget)
  const hostLocale = ${JSON.stringify(locale)};
  const hostDeviceType = ${JSON.stringify(deviceType)};
  const hostUserLocation = ${JSON.stringify(userLocation ?? null)}; // { country, region, city } or null

  // Set document lang attribute per SDK spec: "Host mirrors locale to document.documentElement.lang"
  try { document.documentElement.lang = hostLocale; } catch (e) {}

  // Capability detection (still done in widget for accuracy)
  const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const hasHover = window.matchMedia('(hover: hover)').matches;

  const getSubjectId = () => {
    let subjectId = sessionStorage.getItem('openai_subject_id');
    if (!subjectId) { subjectId = 'anon_' + Math.random().toString(36).substring(2, 15); sessionStorage.setItem('openai_subject_id', subjectId); }
    return subjectId;
  };

  // Auto-resize support: mirror the Apps SDK measurement logic but emit openai:resize
  const postHeight = (() => {
    let lastHeight = 0;
    return (height) => {
      const numericHeight = Number(height);
      if (!Number.isFinite(numericHeight) || numericHeight <= 0) return;
      const roundedHeight = Math.round(numericHeight);
      if (roundedHeight === lastHeight) return;
      lastHeight = roundedHeight;
      window.parent.postMessage({ type: 'openai:resize', height: roundedHeight }, '*');
    };
  })();

  const measureAndNotifyHeight = () => {
    try {
      let contentHeight = 0;

      if (document.body) {
        const children = document.body.children;
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
          const rect = child.getBoundingClientRect();
          const bottom = rect.top + rect.height + window.scrollY;
          contentHeight = Math.max(contentHeight, bottom);
        }

        const bodyStyle = window.getComputedStyle(document.body);
        contentHeight += parseFloat(bodyStyle.marginBottom) || 0;
        contentHeight += parseFloat(bodyStyle.paddingBottom) || 0;
      }

      // Fallback to scroll-based measurement when no children found
      if (contentHeight <= 0) {
        const docEl = document.documentElement;
        contentHeight = Math.max(
          docEl ? docEl.scrollHeight : 0,
          document.body ? document.body.scrollHeight : 0,
        );
      }

      postHeight(Math.ceil(contentHeight));
    } catch (err) {
      console.error('[OpenAI Widget] Failed to measure height:', err);
    }
  };

  const setupAutoResize = () => {
    let scheduled = false;

    const scheduleMeasure = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        measureAndNotifyHeight();
      });
    };

    scheduleMeasure();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(scheduleMeasure);
      resizeObserver.observe(document.documentElement);
      if (document.body) resizeObserver.observe(document.body);
    } else {
      window.addEventListener('resize', scheduleMeasure);
    }

    window.addEventListener('load', () => {
      requestAnimationFrame(measureAndNotifyHeight);
    });
  };

  const openaiAPI = {
    toolInput: ${serializeForInlineScript(toolInput)},
    toolOutput: ${serializeForInlineScript(toolOutput)},
    toolResponseMetadata: ${serializeForInlineScript(toolResponseMetadata)},
    displayMode: 'inline',
    theme: ${JSON.stringify(theme)},
    locale: hostLocale, // Host-controlled per SDK spec
    maxHeight: ${maxHeight != null ? maxHeight : "null"},
    safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
    userAgent: { device: { type: hostDeviceType }, capabilities: { hover: hasHover, touch: hasTouch } },
    view: { mode: ${JSON.stringify(viewMode)}, params: ${serializeForInlineScript(viewParams)} },
    widgetState: null,
    ${useMapPendingCalls ? "_pendingCalls: new Map()," : ""}
    _callId: 0,

    setWidgetState(state) {
      this.widgetState = state;
      try { localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(state)); } catch (err) {}
      window.parent.postMessage({ type: 'openai:setWidgetState', toolId: ${JSON.stringify(toolId)}, state }, '*');
    },

    ${callToolImpl}

    sendFollowUpMessage(opts) {
      const prompt = typeof opts === 'string' ? opts : (opts?.prompt || '');
      window.parent.postMessage({ type: 'openai:sendFollowup', message: prompt, toolId: ${JSON.stringify(toolId)} }, '*');
    },
    /** @deprecated Use sendFollowUpMessage instead. Inspector-only alias. */
    sendFollowupTurn(message) { return this.sendFollowUpMessage(typeof message === 'string' ? message : (message?.prompt || '')); },

    requestDisplayMode(options = {}) {
      const mode = options.mode || 'inline';
      this.displayMode = mode;
      window.parent.postMessage({ type: 'openai:requestDisplayMode', mode, maxHeight: options.maxHeight, toolId: ${JSON.stringify(toolId)} }, '*');
      return { mode };
    },

    requestClose() { window.parent.postMessage({ type: 'openai:requestClose', toolId: ${JSON.stringify(toolId)} }, '*'); },

    openExternal(options) {
      // Official SDK signature: openExternal({ href: string })
      // Inspector also accepts string for convenience, but logs deprecation warning
      let href;
      if (typeof options === 'string') {
        console.warn('[OpenAI SDK] openExternal(string) is deprecated. Use openExternal({ href: string }) instead.');
        href = options;
      } else {
        href = options?.href;
      }
      if (!href) throw new Error('href is required for openExternal. Usage: openExternal({ href: "https://..." })');
      window.parent.postMessage({ type: 'openai:openExternal', href }, '*');
      window.open(href, '_blank', 'noopener,noreferrer');
    },

    /** Inspector-specific: Open widget content in a modal dialog. Not in official SDK. */
    requestModal(options) {
      window.parent.postMessage({ type: 'openai:requestModal', title: options.title, params: options.params, anchor: options.anchor }, '*');
    },

    /** Inspector-specific: Explicitly report content height. Widgets can also use openai:resize event. */
    notifyIntrinsicHeight(height) {
      postHeight(height);
    }
  };

  Object.defineProperty(window, 'openai', { value: openaiAPI, writable: false, configurable: false, enumerable: true });
  // Inspector-specific: window.webplus is an alias for legacy compatibility
  Object.defineProperty(window, 'webplus', { value: openaiAPI, writable: false, configurable: false, enumerable: true });

  setTimeout(() => {
    try {
      window.dispatchEvent(new CustomEvent('openai:set_globals', {
        detail: { globals: { displayMode: openaiAPI.displayMode, maxHeight: openaiAPI.maxHeight, theme: openaiAPI.theme, locale: openaiAPI.locale, safeArea: openaiAPI.safeArea, userAgent: openaiAPI.userAgent } }
      }));
    } catch (err) { console.error('[OpenAI Widget] Failed to dispatch globals event:', err); }
  }, 0);

  setTimeout(() => {
    try {
      const stored = localStorage.getItem(${JSON.stringify(widgetStateKey)});
      if (stored && window.openai) window.openai.widgetState = JSON.parse(stored);
    } catch (err) { console.error('[OpenAI Widget] Failed to restore widget state:', err); }
  }, 0);

  window.addEventListener('message', (event) => {
    const { type, callId, result, error, globals } = event.data || {};
    switch (type) {
      ${callToolResponseHandler}
      case 'openai:set_globals':
        if (globals) {
          if (globals.displayMode !== undefined) window.openai.displayMode = globals.displayMode;
          if (globals.maxHeight !== undefined) window.openai.maxHeight = globals.maxHeight;
          if (globals.theme !== undefined) window.openai.theme = globals.theme;
          if (globals.locale !== undefined) window.openai.locale = globals.locale;
          if (globals.safeArea !== undefined) window.openai.safeArea = globals.safeArea;
          if (globals.userAgent !== undefined) window.openai.userAgent = globals.userAgent;
          if (globals.view !== undefined) window.openai.view = globals.view;
        }
        try { window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } })); } catch (err) {}
        break;
      case 'openai:pushWidgetState':
        if (event.data.toolId === ${JSON.stringify(toolId)}) {
          try {
            const nextState = event.data.state ?? null;
            window.openai.widgetState = nextState;
            try { localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(nextState)); } catch (err) {}
            window.dispatchEvent(new CustomEvent('openai:widget_state', { detail: { state: nextState } }));
          } catch (err) { console.error('[OpenAI Widget] Failed to apply pushed widget state:', err); }
        }
        break;
      case 'openai:requestResize':
        measureAndNotifyHeight();
        break;
    }
  });

  window.addEventListener('openai:resize', (event) => {
    try {
      const detail = event && typeof event === 'object' && 'detail' in event ? (event.detail || {}) : {};
      const height = typeof detail?.height === 'number'
        ? detail.height
        : typeof detail?.size?.height === 'number'
          ? detail.size.height
          : null;
      if (height != null) {
        postHeight(height);
      } else {
        measureAndNotifyHeight();
      }
    } catch (err) { console.error('[OpenAI Widget] Failed to process resize event:', err); }
  });

  // Auto-resize using ResizeObserver + rAF, mirroring Apps SDK behavior
  setupAutoResize();
})();
</script>`;
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

function injectScripts(
  html: string,
  urlPolyfill: string,
  baseTag: string,
  apiScript: string,
): string {
  if (/<html[^>]*>/i.test(html) && /<head[^>]*>/i.test(html)) {
    return html.replace(
      /<head[^>]*>/i,
      `$&${urlPolyfill}${baseTag}${apiScript}`,
    );
  }
  return `<!DOCTYPE html><html><head>${urlPolyfill}${baseTag}<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${apiScript}</head><body>${html}</body></html>`;
}

// ============================================================================
// CSP Configuration
// ============================================================================

const defaultResourceDomains = [
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://cdn.tailwindcss.com",
];
const isDev = process.env.NODE_ENV !== "production";
const devResourceDomains = isDev
  ? [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "ws://localhost:3000",
      "ws://localhost:5173",
    ]
  : [];
const devConnectDomains = isDev ? ["https:", "wss:", "ws:"] : [];
const devScriptDomains = isDev ? ["https:"] : [];
const trustedCdns = [
  "https://persistent.oaistatic.com",
  "https://*.oaistatic.com",
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://cdn.skypack.dev",
  "https://apps-sdk-widgets.vercel.app",
  "https://dynamic.heygen.ai",
  "https://static.heygen.ai",
  "https://files2.heygen.ai",
].join(" ");

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
      timestamp: Date.now(),
    });
    return c.json({ success: true });
  } catch (error) {
    console.error("Error storing widget data:", error);
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

    const resourceMeta = firstContent?._meta as
      | Record<string, unknown>
      | undefined;
    const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
      | { connect_domains?: string[]; resource_domains?: string[] }
      | undefined;

    const baseResourceDomains =
      widgetCspRaw?.resource_domains || defaultResourceDomains;
    const csp = widgetCspRaw
      ? {
          connectDomains: [
            ...(widgetCspRaw.connect_domains || []),
            ...devResourceDomains,
            ...devConnectDomains,
          ],
          resourceDomains: [
            ...baseResourceDomains,
            ...devResourceDomains,
            ...devScriptDomains,
          ],
        }
      : {
          connectDomains: [...devResourceDomains, ...devConnectDomains],
          resourceDomains: [
            ...defaultResourceDomains,
            ...devResourceDomains,
            ...devScriptDomains,
          ],
        };

    const baseUrl = extractBaseUrl(htmlContent);
    const apiScript = generateApiScript({
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
      useMapPendingCalls: true,
    });
    const modifiedHtml = injectScripts(
      htmlContent,
      generateUrlPolyfillScript(baseUrl),
      baseUrl ? `<base href="${baseUrl}">` : "",
      apiScript,
    );

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({
      html: modifiedHtml,
      csp,
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
    console.error("Error serving widget HTML:", error);
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
  const response = await fetch('/api/mcp/openai/widget-content/${toolId}' + searchParams);
  const html = await response.text();
  document.open(); document.write(html); document.close();
})();
</script></body></html>`);
});

chatgpt.get("/widget-content/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");
    const viewMode = c.req.query("view_mode") || "inline";
    let viewParams = {};
    try {
      const vp = c.req.query("view_params");
      if (vp) viewParams = JSON.parse(vp);
    } catch (e) {}

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
    } = widgetData;
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

    const content = await mcpClientManager.readResource(resolved.id, { uri });
    const { html: htmlContent } = extractHtmlContent(content);
    if (!htmlContent)
      return c.html(
        "<html><body>Error: No HTML content found</body></html>",
        404,
      );

    const apiScript = generateApiScript({
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
      viewMode,
      viewParams,
      useMapPendingCalls: false,
    });
    const modifiedHtml = injectScripts(
      htmlContent,
      "",
      '<base href="/">',
      apiScript,
    );

    c.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${trustedCdns}`,
        "worker-src 'self' blob:",
        "child-src 'self' blob:",
        `style-src 'self' 'unsafe-inline' ${trustedCdns}`,
        "img-src 'self' data: https: blob:",
        "media-src 'self' data: https: blob:",
        `font-src 'self' data: ${trustedCdns}`,
        "connect-src 'self' https: wss: ws:",
        "frame-ancestors 'self'",
      ].join("; "),
    );
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");

    return c.html(modifiedHtml);
  } catch (error) {
    console.error("Error serving widget content:", error);
    return c.html(
      `<html><body>Error: ${error instanceof Error ? error.message : "Unknown error"}</body></html>`,
      500,
    );
  }
});

export default chatgpt;
