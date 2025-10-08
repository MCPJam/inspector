import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const resources = new Hono();

// List resources endpoint
resources.post("/list", async (c) => {
  try {
    const { serverId } = await c.req.json();

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpJamClientManager;
    const serverResources = mcpClientManager.getResourcesForServer(serverId);
    return c.json({ resources: { [serverId]: serverResources } });
  } catch (error) {
    console.error("Error fetching resources:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Read resource endpoint
resources.post("/read", async (c) => {
  try {
    const { serverId, uri } = await c.req.json();

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }

    if (!uri) {
      return c.json(
        {
          success: false,
          error: "Resource URI is required",
        },
        400,
      );
    }

    const mcpClientManager = c.mcpJamClientManager;

    const content = await mcpClientManager.getResource(uri, serverId);

    return c.json({ content });
  } catch (error) {
    console.error("Error reading resource:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Serve OpenAI widget HTML with injected API
resources.get("/openai-widget/:serverId/:uri", async (c) => {
  try {
    const serverId = c.req.param("serverId");
    const encodedUri = c.req.param("uri");
    const uri = decodeURIComponent(encodedUri);

    // Get query params for tool data
    const toolInputRaw = c.req.query("toolInput") || "{}";
    const toolOutputRaw = c.req.query("toolOutput") || "null";
    const toolId = c.req.query("toolId") || "unknown";

    // Parse and re-stringify to ensure valid JSON and prevent XSS
    let toolInput: any;
    let toolOutput: any;
    try {
      toolInput = JSON.parse(toolInputRaw);
      toolOutput = JSON.parse(toolOutputRaw);
    } catch (err) {
      return c.html(
        "<html><body>Error: Invalid JSON in toolInput or toolOutput</body></html>",
        400,
      );
    }

    const mcpClientManager = c.mcpJamClientManager;
    const connectedServers = mcpClientManager.getConnectedServers();

    // Try to find the actual server ID
    let actualServerId = serverId;
    if (!connectedServers[serverId]) {
      // Try to find a server that matches (case-insensitive)
      const serverNames = Object.keys(connectedServers);
      const match = serverNames.find(
        (name) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        actualServerId = match;
      } else {
        return c.html(
          `<html><body>
            <h3>Error: Server not connected</h3>
            <p>Requested server: ${serverId}</p>
            <p>Available servers: ${serverNames.join(", ")}</p>
          </body></html>`,
          404,
        );
      }
    }

    const content = await mcpClientManager.getResource(uri, actualServerId);

    // Extract HTML from content
    let htmlContent = "";
    if (Array.isArray(content)) {
      htmlContent = content[0]?.text || content[0]?.blob || "";
    } else if (content && typeof content === "object") {
      htmlContent = (content as any).text || (content as any).blob || "";
      if (!htmlContent && Array.isArray((content as any).contents)) {
        htmlContent =
          (content as any).contents[0]?.text ||
          (content as any).contents[0]?.blob ||
          "";
      }
    }

    if (!htmlContent) {
      return c.html(
        "<html><body>Error: No HTML content found</body></html>",
        404,
      );
    }

    // Widget state key for localStorage persistence
    const widgetStateKey = `openai-widget-state:${toolId}`;

    // Inject OpenAI Apps SDK widget API
    // This provides window.openai for component interaction
    const apiScript = `
      <script>
        (function() {
          'use strict';

          // Create the OpenAI API object
          const openaiAPI = {
            // Data properties (immutable)
            toolInput: ${JSON.stringify(toolInput)},
            toolOutput: ${JSON.stringify(toolOutput)},

            // Layout globals (mutable)
            displayMode: 'inline',
            maxHeight: 600,
            theme: 'dark',
            locale: 'en-US',
            safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
            userAgent: {},
            widgetState: null,

            // Persist widget state
            async setWidgetState(state) {
              this.widgetState = state;
              try {
                localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(state));
              } catch (err) {
                console.error('[OpenAI Widget] Failed to save widget state:', err);
              }
              window.parent.postMessage({
                type: 'openai:setWidgetState',
                toolId: ${JSON.stringify(toolId)},
                state
              }, '*');
            },

            // Call MCP tool from component
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

                // Timeout after 30 seconds
                setTimeout(() => {
                  window.removeEventListener('message', handler);
                  reject(new Error('Tool call timeout'));
                }, 30000);
              });
            },

            // Send follow-up message
            async sendFollowupTurn(message) {
              const payload = typeof message === 'string'
                ? { prompt: message }
                : message;

              window.parent.postMessage({
                type: 'openai:sendFollowup',
                message: payload.prompt || payload
              }, '*');
            },

            // Request display mode change
            async requestDisplayMode(options = {}) {
              const mode = options.mode || 'inline';
              this.displayMode = mode;

              window.parent.postMessage({
                type: 'openai:requestDisplayMode',
                mode
              }, '*');

              return { mode };
            },

            // Legacy alias for webplus compatibility
            async sendFollowUpMessage(args) {
              const prompt = typeof args === 'string' ? args : (args?.prompt || '');
              return this.sendFollowupTurn(prompt);
            }
          };

          // Define window.openai (read-only)
          Object.defineProperty(window, 'openai', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          // Define window.webplus alias (OpenAI components check for this first!)
          Object.defineProperty(window, 'webplus', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          // Fire initial globals event for components using useSyncExternalStore
          try {
            const globalsEvent = new CustomEvent('webplus:set_globals', {
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
            // Silently fail
          }

          // Restore widget state from localStorage
          setTimeout(() => {
            try {
              const stored = localStorage.getItem(${JSON.stringify(widgetStateKey)});
              if (stored && window.openai) {
                window.openai.widgetState = JSON.parse(stored);
              }
            } catch (err) {
              // Silently fail
            }
          }, 0);
        })();
      </script>
    `;

    // Create proper HTML structure with our script executing FIRST
    let modifiedHtml;

    if (htmlContent.includes("<html>") && htmlContent.includes("<head>")) {
      // Already has proper structure, inject at start of head
      modifiedHtml = htmlContent.replace("<head>", "<head>" + apiScript);
    } else {
      // Create full HTML structure with our script BEFORE any content
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

    // Set security headers
    // Match ChatGPT's CSP model: Allow trusted CDNs that developers commonly use
    // This balances security with developer flexibility
    const trustedCdns = [
      "https://persistent.oaistatic.com",
      "https://*.oaistatic.com",
      "https://unpkg.com",
      "https://cdn.jsdelivr.net",
      "https://cdnjs.cloudflare.com",
      "https://cdn.skypack.dev",
    ].join(" ");

    c.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${trustedCdns}`,
        "worker-src 'self' blob:", // Allow web workers (needed for Mapbox)
        "child-src 'self' blob:", // Allow blob URLs for workers
        `style-src 'self' 'unsafe-inline' ${trustedCdns}`,
        "img-src 'self' data: https: blob:", // Allow images from any HTTPS source
        `font-src 'self' data: ${trustedCdns}`,
        "connect-src 'self' https: wss: ws:", // Allow WebSocket and HTTPS connections
        "frame-ancestors 'self'",
      ].join("; "),
    );
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header("X-Content-Type-Options", "nosniff");

    return c.html(modifiedHtml);
  } catch (error) {
    return c.html(
      `<html><body>Error: ${error instanceof Error ? error.message : "Unknown error"}</body></html>`,
      500,
    );
  }
});

export default resources;
