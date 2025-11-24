import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import {
  widgetDataStore,
  getOpenAiBridgeScript,
  extractHtmlContent,
  injectBridgeScript,
} from "./widget-utils";

const openai = new Hono();

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

  // Determine the base path for widget content
  // If accessed through adapter-http, use the full request path
  const requestPath = new URL(c.req.url).pathname;
  let widgetContentUrl = `/api/mcp/openai/widget-content/${toolId}`;

  // If this is being accessed through adapter-http proxy (contains /adapter-http/ in path)
  // we need to use the relative path from the current location
  if (requestPath.includes('/adapter-http/')) {
    // Extract the serverId from the path: /api/mcp/adapter-http/{serverId}/widget/{toolId}
    const match = requestPath.match(/\/adapter-http\/([^/]+)\/widget/);
    if (match) {
      // Use relative path so it works regardless of the domain (ngrok or direct)
      widgetContentUrl = `./widget-content/${toolId}`;
    }
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
          const response = await fetch('${widgetContentUrl}' + searchParams);
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

    const htmlContent = extractHtmlContent(content);

    if (!htmlContent) {
      return c.html(
        "<html><body>Error: No HTML content found</body></html>",
        404,
      );
    }

    // OpenAI Apps SDK bridge script
    const apiScript = getOpenAiBridgeScript(
      toolInput,
      toolOutput,
      toolResponseMetadata,
      theme,
      toolId,
      toolName,
      viewMode,
      viewParams
    );

    // Inject the bridge script into the HTML
    const modifiedHtml = injectBridgeScript(htmlContent, apiScript, '<base href="/">');

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
