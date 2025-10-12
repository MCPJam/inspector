import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const resources = new Hono();

// List resources endpoint
resources.post("/list", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    const { resources } = await mcpClientManager.listResources(serverId);
    return c.json({ resources });
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
    const { serverId, uri } = (await c.req.json()) as {
      serverId?: string;
      uri?: string;
    };

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

    const mcpClientManager = c.mcpClientManager;

    const content = await mcpClientManager.readResource(serverId, {
      uri,
    });

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

// Simpler widget endpoint for React Router compatibility
// Container page that changes URL to "/" before loading widget
resources.get("/widget/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const widgetData = c.req.query("data");

  if (!widgetData) {
    return c.html("<html><body>Error: Missing widget data</body></html>", 400);
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
          // Change URL to "/" BEFORE loading widget (for React Router)
          history.replaceState(null, '', '/');

          // Fetch the actual widget HTML
          const response = await fetch('/api/mcp/resources/widget-content?data=${encodeURIComponent(widgetData)}');
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

// Actual widget content endpoint
resources.get("/widget-content", async (c) => {
  try {
    const widgetData = c.req.query("data");

    if (!widgetData) {
      return c.html(
        "<html><body>Error: Missing widget data</body></html>",
        400,
      );
    }

    // Decode widget data (base64 encoded JSON with Unicode support)
    const base64Decoded = Buffer.from(widgetData, "base64").toString("binary");
    const percentEncoded = base64Decoded
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join("");
    const jsonString = decodeURIComponent(percentEncoded);
    const { serverId, uri, toolInput, toolOutput, toolId } =
      JSON.parse(jsonString);

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

    const widgetStateKey = `openai-widget-state:${toolId}`;

    const apiScript = `
      <script>
        (function() {
          'use strict';

          const openaiAPI = {
            toolInput: ${JSON.stringify(toolInput)},
            toolOutput: ${JSON.stringify(toolOutput)},
            displayMode: 'inline',
            maxHeight: 600,
            theme: 'dark',
            locale: 'en-US',
            safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
            userAgent: {},
            widgetState: null,

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
            }
          };

          Object.defineProperty(window, 'openai', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          Object.defineProperty(window, 'webplus', {
            value: openaiAPI,
            writable: false,
            configurable: false,
            enumerable: true
          });

          setTimeout(() => {
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
            } catch (err) {}
          }, 0);

          setTimeout(() => {
            try {
              const stored = localStorage.getItem(${JSON.stringify(widgetStateKey)});
              if (stored && window.openai) {
                window.openai.widgetState = JSON.parse(stored);
              }
            } catch (err) {}
          }, 0);
        })();
      </script>
    `;

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

    return c.html(modifiedHtml);
  } catch (error) {
    return c.html(
      `<html><body>Error: ${error instanceof Error ? error.message : "Unknown error"}</body></html>`,
      500,
    );
  }
});

export default resources;
