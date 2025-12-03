import { Hono } from "hono";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "../../types/hono"; // Type extensions

const openai = new Hono();

// Get directory for static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In-memory storage for widget data (TTL: 1 hour)
interface WidgetData {
  serverId: string;
  uri: string;
  toolInput: Record<string, any>;
  toolOutput: any;
  toolResponseMetadata?: Record<string, any> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  timestamp: number;
}

const widgetDataStore = new Map<string, WidgetData>();

const serializeForInlineScript = (value: unknown) =>
  JSON.stringify(value ?? null)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

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

// Store widget data endpoint
openai.post("/widget/store", async (c) => {
  try {
    const body = await c.req.json();
    const {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      toolId,
      toolName,
      theme,
    } = body;

    if (!serverId || !uri || !toolId || !toolName) {
      return c.json({ success: false, error: "Missing required fields" }, 400);
    }

    // Store widget data using toolId as key
    widgetDataStore.set(toolId, {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata: toolResponseMetadata ?? null,
      toolId,
      toolName,
      theme: theme ?? "dark",
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

// Serve the OpenAI sandbox proxy with security headers
openai.get("/sandbox-proxy", (c) => {
  const html = readFileSync(
    join(__dirname, "openai-sandbox-proxy.html"),
    "utf-8"
  );
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  // Security: Prevent embedding by malicious sites
  c.header("Content-Security-Policy", "frame-ancestors 'self'");
  c.header("X-Frame-Options", "SAMEORIGIN");
  return c.body(html);
});

// Default CDNs for widgets that don't declare CSP
const defaultResourceDomains = [
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://cdn.tailwindcss.com",
];

// In development, allow broader access for widget dev servers
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

// In dev, allow https: for API calls (widgets often call external APIs)
// In production, widgets should declare their domains in openai/widgetCSP
const devConnectDomains = isDev ? ["https:", "wss:", "ws:"] : [];

// In dev, also allow https: for scripts/styles to test production widgets
// In production, widgets MUST declare their domains in openai/widgetCSP
const devScriptDomains = isDev ? ["https:"] : [];

// New endpoint: Returns widget HTML + CSP as JSON for double-iframe architecture
openai.get("/widget-html/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");

    // Retrieve widget data from storage
    const widgetData = widgetDataStore.get(toolId);
    if (!widgetData) {
      return c.json({ error: "Widget data not found or expired" }, 404);
    }

    const {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      toolName,
      theme,
    } = widgetData;

    const mcpClientManager = c.mcpClientManager;
    const availableServers = mcpClientManager
      .listServers()
      .filter((id) => Boolean(mcpClientManager.getClient(id)));

    let actualServerId = serverId;
    if (!availableServers.includes(serverId)) {
      const match = availableServers.find(
        (name) => name.toLowerCase() === serverId.toLowerCase()
      );
      if (match) {
        actualServerId = match;
      } else {
        return c.json(
          {
            error: `Server not connected. Requested: ${serverId}, Available: ${availableServers.join(", ")}`,
          },
          404
        );
      }
    }

    // Read the widget HTML from MCP server
    const content = await mcpClientManager.readResource(actualServerId, {
      uri,
    });

    let htmlContent = "";
    const contentsArray = Array.isArray(content?.contents)
      ? content.contents
      : [];

    const firstContent = contentsArray[0];
    if (firstContent) {
      if (typeof (firstContent as { text?: unknown }).text === "string") {
        htmlContent = (firstContent as { text: string }).text;
      } else if (
        typeof (firstContent as { blob?: unknown }).blob === "string"
      ) {
        htmlContent = (firstContent as { blob: string }).blob;
      }
    }

    if (!htmlContent && content && typeof content === "object") {
      const recordContent = content as Record<string, unknown>;
      if (typeof recordContent.text === "string") {
        htmlContent = recordContent.text;
      } else if (typeof recordContent.blob === "string") {
        htmlContent = recordContent.blob;
      }
    }

    if (!htmlContent) {
      return c.json({ error: "No HTML content found" }, 404);
    }

    // Extract CSP from resource metadata
    const resourceMeta = (firstContent as { _meta?: Record<string, unknown> })
      ?._meta;
    const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
      | {
          connect_domains?: string[];
          resource_domains?: string[];
        }
      | undefined;

    // Build CSP config (snake_case from metadata -> camelCase for JS)
    // In dev mode:
    // - Add localhost ports for widget dev servers (Vite HMR, etc.)
    // - Allow https: for API calls and script/style loading
    // In production, widgets MUST declare their domains in openai/widgetCSP
    const baseResourceDomains = widgetCspRaw?.resource_domains || defaultResourceDomains;
    const csp = widgetCspRaw
      ? {
          connectDomains: [...(widgetCspRaw.connect_domains || []), ...devResourceDomains, ...devConnectDomains],
          resourceDomains: [...baseResourceDomains, ...devResourceDomains, ...devScriptDomains],
        }
      : {
          connectDomains: [...devResourceDomains, ...devConnectDomains],
          resourceDomains: [...defaultResourceDomains, ...devResourceDomains, ...devScriptDomains],
        };

    const widgetStateKey = `openai-widget-state:${toolName}:${toolId}`;

    // OpenAI Apps SDK bridge script with full API
    const apiScript = `
      <script>
        (function() {
          'use strict';

          const openaiAPI = {
            toolInput: ${serializeForInlineScript(toolInput)},
            toolOutput: ${serializeForInlineScript(toolOutput)},
            toolResponseMetadata: ${serializeForInlineScript(toolResponseMetadata)},
            displayMode: 'inline',
            theme: ${JSON.stringify(theme ?? "dark")},
            locale: navigator.language || 'en-US',
            maxHeight: null,
            safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
            userAgent: navigator.userAgent,
            widgetState: null,
            _pendingCalls: new Map(),
            _callId: 0,

            setWidgetState(state) {
              this.widgetState = state;
              try {
                localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(state));
              } catch (err) {}
              window.parent.postMessage({
                type: 'openai:setWidgetState',
                toolId: ${JSON.stringify(toolId)},
                state
              }, '*');
            },

            callTool(toolName, args = {}) {
              const callId = ++this._callId;
              return new Promise((resolve, reject) => {
                this._pendingCalls.set(callId, { resolve, reject });
                window.parent.postMessage({
                  type: 'openai:callTool',
                  toolName,
                  args,
                  callId,
                  toolId: ${JSON.stringify(toolId)}
                }, '*');
                setTimeout(() => {
                  if (this._pendingCalls.has(callId)) {
                    this._pendingCalls.delete(callId);
                    reject(new Error('Tool call timeout'));
                  }
                }, 30000);
              });
            },

            sendFollowUpMessage(opts) {
              const prompt = typeof opts === 'string' ? opts : (opts?.prompt || '');
              window.parent.postMessage({
                type: 'openai:sendFollowup',
                message: prompt,
                toolId: ${JSON.stringify(toolId)}
              }, '*');
            },

            // Alias for compatibility
            sendFollowupTurn(message) {
              const prompt = typeof message === 'string' ? message : (message?.prompt || '');
              return this.sendFollowUpMessage(prompt);
            },

            requestDisplayMode(options = {}) {
              const mode = options.mode || 'inline';
              this.displayMode = mode;
              window.parent.postMessage({
                type: 'openai:requestDisplayMode',
                mode,
                maxHeight: options.maxHeight,
                toolId: ${JSON.stringify(toolId)}
              }, '*');
              return { mode };
            },

            requestClose() {
              window.parent.postMessage({
                type: 'openai:requestClose',
                toolId: ${JSON.stringify(toolId)}
              }, '*');
            },

            openExternal(options) {
              const href = typeof options === 'string' ? options : options?.href;
              if (!href) {
                throw new Error('href is required for openExternal');
              }
              window.parent.postMessage({
                type: 'openai:openExternal',
                href
              }, '*');
              window.open(href, '_blank', 'noopener,noreferrer');
            },

            requestModal(options) {
              window.parent.postMessage({
                type: 'openai:requestModal',
                title: options.title,
                params: options.params,
                anchor: options.anchor
              }, '*');
            }
          };

          // Define window.openai
          Object.defineProperty(window, 'openai', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          // Define window.webplus (alias)
          Object.defineProperty(window, 'webplus', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          // Dispatch initial globals event
          setTimeout(() => {
            try {
              const globalsEvent = new CustomEvent('openai:set_globals', {
                detail: {
                  globals: {
                    displayMode: openaiAPI.displayMode,
                    maxHeight: openaiAPI.maxHeight,
                    theme: openaiAPI.theme,
                    locale: openaiAPI.locale,
                    safeArea: openaiAPI.safeArea,
                    userAgent: openaiAPI.userAgent
                  }
                }
              });
              window.dispatchEvent(globalsEvent);
            } catch (err) {
              console.error('[OpenAI Widget] Failed to dispatch globals event:', err);
            }
          }, 0);

          // Restore widget state from localStorage
          setTimeout(() => {
            try {
              const stored = localStorage.getItem(${JSON.stringify(widgetStateKey)});
              if (stored && window.openai) {
                window.openai.widgetState = JSON.parse(stored);
              }
            } catch (err) {
              console.error('[OpenAI Widget] Failed to restore widget state:', err);
            }
          }, 0);

          // Listen for messages from host
          window.addEventListener('message', (event) => {
            const { type, callId, result, error, globals } = event.data || {};

            switch (type) {
              case 'openai:callTool:response': {
                const pending = window.openai._pendingCalls.get(callId);
                if (pending) {
                  window.openai._pendingCalls.delete(callId);
                  if (error) {
                    pending.reject(new Error(error));
                  } else {
                    pending.resolve(result);
                  }
                }
                break;
              }

              case 'openai:set_globals': {
                if (globals) {
                  if (globals.displayMode !== undefined) window.openai.displayMode = globals.displayMode;
                  if (globals.maxHeight !== undefined) window.openai.maxHeight = globals.maxHeight;
                  if (globals.safeArea !== undefined) window.openai.safeArea = globals.safeArea;
                  if (globals.theme !== undefined) window.openai.theme = globals.theme;
                  if (globals.locale !== undefined) window.openai.locale = globals.locale;
                  if (globals.userAgent !== undefined) window.openai.userAgent = globals.userAgent;
                }
                // Dispatch custom event for React hooks
                try {
                  window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
                } catch (err) {}
                break;
              }

              case 'openai:pushWidgetState': {
                if (event.data.toolId === ${JSON.stringify(toolId)}) {
                  try {
                    const nextState = event.data.state ?? null;
                    window.openai.widgetState = nextState;
                    try {
                      localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(nextState));
                    } catch (err) {}
                    window.dispatchEvent(new CustomEvent('openai:widget_state', {
                      detail: { state: nextState }
                    }));
                  } catch (err) {
                    console.error('[OpenAI Widget] Failed to apply pushed widget state:', err);
                  }
                }
                break;
              }
            }
          });

          // Forward resize requests to parent
          window.addEventListener('openai:resize', (event) => {
            try {
              let detail = {};
              if (event && typeof event === 'object' && 'detail' in event) {
                detail = event.detail || {};
              }
              const height = typeof detail?.height === 'number'
                ? detail.height
                : typeof detail?.size?.height === 'number'
                  ? detail.size.height
                  : null;

              if (height && Number.isFinite(height)) {
                window.parent.postMessage({
                  type: 'openai:resize',
                  height
                }, '*');
              }
            } catch (err) {
              console.error('[OpenAI Widget] Failed to forward resize event:', err);
            }
          });
        })();
      </script>
    `;

    // Inject the bridge script into the HTML
    // Note: No <base> tag - CSP has base-uri 'none' for security
    // Widgets should use absolute URLs or rely on their bundled assets
    let modifiedHtml;
    if (htmlContent.includes("<html>") && htmlContent.includes("<head>")) {
      modifiedHtml = htmlContent.replace("<head>", `<head>${apiScript}`);
    } else {
      modifiedHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${apiScript}
</head>
<body>
  ${htmlContent}
</body>
</html>`;
    }

    // Extract other metadata fields
    const widgetDescription = resourceMeta?.["openai/widgetDescription"] as
      | string
      | undefined;
    const prefersBorder =
      (resourceMeta?.["openai/widgetPrefersBorder"] as boolean | undefined) ??
      true;
    const closeWidget =
      (resourceMeta?.["openai/closeWidget"] as boolean | undefined) ?? false;

    c.header("Cache-Control", "no-cache, no-store, must-revalidate");

    return c.json({
      html: modifiedHtml,
      csp,
      widgetDescription,
      prefersBorder,
      closeWidget,
    });
  } catch (error) {
    console.error("Error serving widget HTML:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

// Container page that loads the widget
// This page changes URL to "/" before loading widget (for React Router compatibility)
openai.get("/widget/:toolId", async (c) => {
  const toolId = c.req.param("toolId");

  // Check if data exists in storage
  const widgetData = widgetDataStore.get(toolId);
  if (!widgetData) {
    return c.html(
      "<html><body>Error: Widget data not found or expired</body></html>",
      404,
    );
  }

  // Return a container page that will fetch and load the actual widget
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Loading Widget...</title>
    </head>
    <body>
      <script>
        (async function() {
          const searchParams = window.location.search;
          // Change URL to "/" BEFORE loading widget (for React Router)
          history.replaceState(null, '', '/');

          // Fetch the actual widget HTML using toolId
          const response = await fetch('/api/mcp/openai/widget-content/${toolId}' + searchParams);
          const html = await response.text();

          // Replace entire document with widget HTML
          document.open();
          document.write(html);
          document.close();
        })();
      </script>
    </body>
    </html>
  `);
});

// Actual widget content endpoint with injected OpenAI bridge
openai.get("/widget-content/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");
    const viewMode = c.req.query("view_mode") || "inline";
    const viewParamsStr = c.req.query("view_params");
    let viewParams = {};
    try {
      if (viewParamsStr) {
        viewParams = JSON.parse(viewParamsStr);
      }
    } catch (e) {
      console.error("Failed to parse view_params:", e);
    }

    // Retrieve widget data from storage
    const widgetData = widgetDataStore.get(toolId);
    if (!widgetData) {
      return c.html(
        "<html><body>Error: Widget data not found or expired</body></html>",
        404,
      );
    }

    const {
      serverId,
      uri,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      toolName,
      theme,
    } = widgetData;

    const mcpClientManager = c.mcpClientManager;
    const availableServers = mcpClientManager
      .listServers()
      .filter((id) => Boolean(mcpClientManager.getClient(id)));

    let actualServerId = serverId;
    if (!availableServers.includes(serverId)) {
      const match = availableServers.find(
        (name) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        actualServerId = match;
      } else {
        return c.html(
          `<html><body>
            <h3>Error: Server not connected</h3>
            <p>Requested server: ${serverId}</p>
            <p>Available servers: ${availableServers.join(", ")}</p>
          </body></html>`,
          404,
        );
      }
    }

    // Read the widget HTML from MCP server
    const content = await mcpClientManager.readResource(actualServerId, {
      uri,
    });

    let htmlContent = "";
    const contentsArray = Array.isArray(content?.contents)
      ? content.contents
      : [];

    const firstContent = contentsArray[0];
    if (firstContent) {
      if (typeof (firstContent as { text?: unknown }).text === "string") {
        htmlContent = (firstContent as { text: string }).text;
      } else if (
        typeof (firstContent as { blob?: unknown }).blob === "string"
      ) {
        htmlContent = (firstContent as { blob: string }).blob;
      }
    }

    if (!htmlContent && content && typeof content === "object") {
      const recordContent = content as Record<string, unknown>;
      if (typeof recordContent.text === "string") {
        htmlContent = recordContent.text;
      } else if (typeof recordContent.blob === "string") {
        htmlContent = recordContent.blob;
      }
    }

    if (!htmlContent) {
      return c.html(
        "<html><body>Error: No HTML content found</body></html>",
        404,
      );
    }

    const widgetStateKey = `openai-widget-state:${toolName}:${toolId}`;

    // OpenAI Apps SDK bridge script
    const apiScript = `
      <script>
        (function() {
          'use strict';

          const openaiAPI = {
            toolInput: ${serializeForInlineScript(toolInput)},
            toolOutput: ${serializeForInlineScript(toolOutput)},
            toolResponseMetadata: ${serializeForInlineScript(toolResponseMetadata)},
            displayMode: 'inline',
            theme: ${JSON.stringify(theme ?? "dark")},
            locale: 'en-US',
            safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
            userAgent: {
              device: { type: 'desktop' },
              capabilities: { hover: true, touch: false }
            },
            view: {
              mode: ${JSON.stringify(viewMode)},
              params: ${serializeForInlineScript(viewParams)}
            },
            widgetState: null,

            async setWidgetState(state) {
              this.widgetState = state;
              try {
                localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(state));
              } catch (err) {
              }
              window.parent.postMessage({
                type: 'openai:setWidgetState',
                toolId: ${JSON.stringify(toolId)},
                state
              }, '*');
            },

            async callTool(toolName, params = {}) {
              return new Promise((resolve, reject) => {
                const requestId = \`tool_\${Date.now()}_\${Math.random()}\`;
                const handler = (event) => {
                  if (event.data.type === 'openai:callTool:response' &&
                      event.data.requestId === requestId) {
                    window.removeEventListener('message', handler);
                    if (event.data.error) {
                      reject(new Error(event.data.error));
                    } else {
                      resolve(event.data.result);
                    }
                  }
                };
                window.addEventListener('message', handler);
                window.parent.postMessage({
                  type: 'openai:callTool',
                  requestId,
                  toolName,
                  params
                }, '*');
                setTimeout(() => {
                  window.removeEventListener('message', handler);
                  reject(new Error('Tool call timeout'));
                }, 30000);
              });
            },

            async sendFollowupTurn(message) {
              const payload = typeof message === 'string'
                ? { prompt: message }
                : message;
              window.parent.postMessage({
                type: 'openai:sendFollowup',
                message: payload.prompt || payload
              }, '*');
            },

            async requestDisplayMode(options = {}) {
              const mode = options.mode || 'inline';
              this.displayMode = mode;
              window.parent.postMessage({
                type: 'openai:requestDisplayMode',
                mode
              }, '*');
              return { mode };
            },

            async sendFollowUpMessage(args) {
              const prompt = typeof args === 'string' ? args : (args?.prompt || '');
              return this.sendFollowupTurn(prompt);
            },

            async openExternal(options) {
              const href = typeof options === 'string' ? options : options?.href;
              if (!href) {
                throw new Error('href is required for openExternal');
              }
              window.parent.postMessage({
                type: 'openai:openExternal',
                href
              }, '*');
              window.open(href, '_blank', 'noopener,noreferrer');
            },

            async requestModal(options) {
              window.parent.postMessage({
                type: 'openai:requestModal',
                title: options.title,
                params: options.params,
                anchor: options.anchor
              }, '*');
            },

            requestClose() {
              window.parent.postMessage({
                type: 'openai:requestClose',
                toolId: ${JSON.stringify(toolId)}
              }, '*');
            }
          };

          // Define window.openai
          Object.defineProperty(window, 'openai', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          // Define window.webplus (alias)
          Object.defineProperty(window, 'webplus', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          // Dispatch initial globals event
          setTimeout(() => {
            try {
              const globalsEvent = new CustomEvent('openai:set_globals', {
                detail: {
                  globals: {
                    displayMode: openaiAPI.displayMode,
                    maxHeight: openaiAPI.maxHeight,
                    theme: openaiAPI.theme,
                    locale: openaiAPI.locale,
                    safeArea: openaiAPI.safeArea,
                    userAgent: openaiAPI.userAgent
                  }
                }
              });
              window.dispatchEvent(globalsEvent);
            } catch (err) {
              console.error('[OpenAI Widget] Failed to dispatch globals event:', err);
            }
          }, 0);

          // Restore widget state from localStorage
          setTimeout(() => {
            try {
              const stored = localStorage.getItem(${JSON.stringify(widgetStateKey)});
              if (stored && window.openai) {
                window.openai.widgetState = JSON.parse(stored);
              }
            } catch (err) {
              console.error('[OpenAI Widget] Failed to restore widget state:', err);
            }
          }, 0);

          // Listen for theme changes from parent
          window.addEventListener('message', (event) => {
            if (event.data.type === 'openai:set_globals') {
              const { globals } = event.data;

              if (globals?.theme && window.openai) {
                window.openai.theme = globals.theme;

                // Dispatch event for widgets that use useTheme() hook
                try {
                  const globalsEvent = new CustomEvent('openai:set_globals', {
                    detail: { globals: { theme: globals.theme } }
                  });
                  window.dispatchEvent(globalsEvent);
                } catch (err) {
                  console.error('[OpenAI Widget] Failed to dispatch theme change:', err);
                }
              }

              if (typeof globals?.maxHeight === 'number' && window.openai) {
                window.openai.maxHeight = globals.maxHeight;
                try {
                  const globalsEvent = new CustomEvent('openai:set_globals', {
                    detail: { globals: { maxHeight: globals.maxHeight } }
                  });
                  window.dispatchEvent(globalsEvent);
                } catch (err) {
                  console.error('[OpenAI Widget] Failed to dispatch maxHeight change:', err);
                }
              }

              if (globals?.displayMode && window.openai) {
                window.openai.displayMode = globals.displayMode;
                try {
                  const globalsEvent = new CustomEvent('openai:set_globals', {
                    detail: { globals: { displayMode: globals.displayMode } }
                  });
                  window.dispatchEvent(globalsEvent);
                } catch (err) {
                  console.error('[OpenAI Widget] Failed to dispatch displayMode change:', err);
                }
              }
            }

            if (event.data.type === 'openai:pushWidgetState' && event.data.toolId === ${JSON.stringify(toolId)}) {
              try {
                const nextState = event.data.state ?? null;
                window.openai.widgetState = nextState;
                try {
                  localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(nextState));
                } catch (err) {
                }
                try {
                  const stateEvent = new CustomEvent('openai:widget_state', {
                    detail: { state: nextState }
                  });
                  window.dispatchEvent(stateEvent);
                } catch (err) {
                  console.error('[OpenAI Widget] Failed to dispatch widget state event:', err);
                }
              } catch (err) {
                console.error('[OpenAI Widget] Failed to apply pushed widget state:', err);
              }
            }
          });

          // Forward resize requests from the widget to the parent so the host can grow the iframe
          window.addEventListener('openai:resize', (event) => {
            try {
              let detail = {};
              if (event && typeof event === 'object' && 'detail' in event) {
                // event is expected to be a CustomEvent
                // @ts-ignore - event.detail is fine at runtime
                detail = event.detail || {};
              }
              const height = typeof detail?.height === 'number'
                ? detail.height
                : typeof detail?.size?.height === 'number'
                  ? detail.size.height
                  : null;

              if (height && Number.isFinite(height)) {
                window.parent.postMessage({
                  type: 'openai:resize',
                  height
                }, '*');
              }
            } catch (err) {
              console.error('[OpenAI Widget] Failed to forward resize event:', err);
            }
          });
        })();
      </script>
    `;

    // Inject the bridge script into the HTML
    let modifiedHtml;
    if (htmlContent.includes("<html>") && htmlContent.includes("<head>")) {
      modifiedHtml = htmlContent.replace(
        "<head>",
        `<head><base href="/">${apiScript}`,
      );
    } else {
      modifiedHtml = `<!DOCTYPE html>
<html>
<head>
  <base href="/">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${apiScript}
</head>
<body>
  ${htmlContent}
</body>
</html>`;
    }

    // Security headers
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

    // Disable caching for widget content (always fetch fresh HTML from MCP server)
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

export default openai;
