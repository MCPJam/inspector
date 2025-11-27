/**
 * MCP Apps (SEP-1865) Server Routes
 *
 * Provides endpoints for storing widget data and serving widget HTML.
 * Widgets are expected to use the official SDK (@modelcontextprotocol/ext-apps)
 * which handles JSON-RPC communication with the host.
 */

import { Hono } from "hono";
import "../../types/hono";

const apps = new Hono();

// Widget data store - SAME PATTERN as openai.ts
interface WidgetData {
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  protocol: "mcp-apps";
  timestamp: number;
}

const widgetDataStore = new Map<string, WidgetData>();

// Cleanup expired data every 5 minutes - SAME as openai.ts
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

// Store widget data - SAME pattern as openai.ts
apps.post("/widget/store", async (c) => {
  try {
    const body = await c.req.json();
    const {
      serverId,
      resourceUri,
      toolInput,
      toolOutput,
      toolId,
      toolName,
      theme,
      protocol,
    } = body;

    if (!serverId || !resourceUri || !toolId || !toolName) {
      return c.json({ success: false, error: "Missing required fields" }, 400);
    }

    widgetDataStore.set(toolId, {
      serverId,
      resourceUri,
      toolInput,
      toolOutput,
      toolId,
      toolName,
      theme: theme ?? "dark",
      protocol: protocol ?? "mcp-apps",
      timestamp: Date.now(),
    });

    return c.json({ success: true });
  } catch (error) {
    console.error("[MCP Apps] Error storing widget data:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Serve widget HTML content
apps.get("/widget-content/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");
    const widgetData = widgetDataStore.get(toolId);

    if (!widgetData) {
      return c.html(
        "<html><body>Error: Widget data not found or expired</body></html>",
        404,
      );
    }

    const { serverId, resourceUri } = widgetData;
    const mcpClientManager = c.mcpClientManager;

    // REUSE existing mcpClientManager.readResource (same as resources.ts)
    const resourceResult = await mcpClientManager.readResource(serverId, {
      uri: resourceUri,
    });

    // Extract HTML from resource contents
    const contents = resourceResult?.contents || [];
    const content = contents[0];

    if (!content) {
      return c.html(
        "<html><body>Error: No content in resource</body></html>",
        404,
      );
    }

    let html: string;
    if ("text" in content && typeof content.text === "string") {
      html = content.text;
    } else if ("blob" in content && typeof content.blob === "string") {
      html = Buffer.from(content.blob, "base64").toString("utf-8");
    } else {
      return c.html(
        "<html><body>Error: No HTML content in resource</body></html>",
        404,
      );
    }

    // Return HTML as-is - widgets using the official SDK (@modelcontextprotocol/ext-apps)
    // handle JSON-RPC communication themselves. No script injection needed.
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.body(html);
  } catch (error) {
    console.error("[MCP Apps] Error fetching resource:", error);
    return c.html(
      `<html><body>Error: ${error instanceof Error ? error.message : "Unknown error"}</body></html>`,
      500,
    );
  }
});

export default apps;
