/**
 * MCP Apps (SEP-1865) Server Routes
 *
 * Provides endpoints for storing widget data and serving widget HTML.
 * Widgets are expected to use the official SDK (@modelcontextprotocol/ext-apps)
 * which handles JSON-RPC communication with the host.
 */

import { Hono } from "hono";
import "../../types/hono";
import { logger } from "../../utils/logger";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";

const apps = new Hono();

/**
 * SEP-1865 mandated mimetype for MCP Apps
 * @see https://github.com/anthropics/anthropic-cookbook/blob/main/misc/sep-1865-mcp-apps.md
 */
const MCP_APPS_MIMETYPE = RESOURCE_MIME_TYPE;

/**
 * CSP mode types - matches client-side CspMode type
 */
type CspMode = "permissive" | "widget-declared";

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
  cspMode: CspMode; // CSP enforcement mode
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
      cspMode,
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
      cspMode: cspMode ?? "permissive", // Default to permissive mode
      timestamp: Date.now(),
    });

    return c.json({ success: true });
  } catch (error) {
    logger.error("[MCP Apps] Error storing widget data", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// CSP metadata type per SEP-1865
interface UIResourceCSP {
  connectDomains?: string[];
  resourceDomains?: string[];
}

interface UIResourceMeta {
  csp?: UIResourceCSP;
  domain?: string;
  prefersBorder?: boolean;
}

// Serve widget content with CSP metadata (SEP-1865)
apps.get("/widget-content/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");
    const widgetData = widgetDataStore.get(toolId);

    if (!widgetData) {
      return c.json({ error: "Widget data not found or expired" }, 404);
    }

    // Read CSP mode from query param (allows override for testing)
    const cspModeParam = c.req.query("csp_mode") as CspMode | undefined;

    const { serverId, resourceUri, cspMode: storedCspMode } = widgetData;

    // Use query param override if provided, otherwise use stored mode
    const effectiveCspMode = cspModeParam ?? storedCspMode ?? "permissive";
    const mcpClientManager = c.mcpClientManager;

    // REUSE existing mcpClientManager.readResource (same as resources.ts)
    const resourceResult = await mcpClientManager.readResource(serverId, {
      uri: resourceUri,
    });

    // Extract HTML from resource contents
    const contents = resourceResult?.contents || [];
    const content = contents[0];

    if (!content) {
      return c.json({ error: "No content in resource" }, 404);
    }

    // SEP-1865: Validate mimetype - MUST be "text/html;profile=mcp-app"
    const contentMimeType = (content as { mimeType?: string }).mimeType;
    const mimeTypeValid = contentMimeType === MCP_APPS_MIMETYPE;
    const mimeTypeWarning = !mimeTypeValid
      ? contentMimeType
        ? `Invalid mimetype "${contentMimeType}" - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
        : `Missing mimetype - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
      : null;

    if (mimeTypeWarning) {
      logger.warn("[MCP Apps] Mimetype validation: " + mimeTypeWarning, {
        resourceUri,
      });
    }

    let html: string;
    if ("text" in content && typeof content.text === "string") {
      html = content.text;
    } else if ("blob" in content && typeof content.blob === "string") {
      html = Buffer.from(content.blob, "base64").toString("utf-8");
    } else {
      return c.json({ error: "No HTML content in resource" }, 404);
    }

    // Extract CSP and other UI metadata from resource _meta (SEP-1865)
    const uiMeta = (content._meta as { ui?: UIResourceMeta } | undefined)?.ui;
    const csp = uiMeta?.csp;
    const prefersBorder = uiMeta?.prefersBorder;

    // Log CSP configuration for security review (SEP-1865)
    logger.debug("[MCP Apps] CSP configuration", {
      resourceUri,
      effectiveCspMode,
      widgetDeclaredCsp: csp
        ? {
            connectDomains: csp.connectDomains || [],
            resourceDomains: csp.resourceDomains || [],
          }
        : null,
    });

    // When in permissive mode, skip CSP entirely (for testing/debugging)
    // When in widget-declared mode, use the widget's CSP metadata (or restrictive defaults)
    const isPermissive = effectiveCspMode === "permissive";

    // Return JSON with HTML and metadata for CSP enforcement
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({
      html,
      csp: isPermissive ? undefined : csp,
      permissive: isPermissive, // Tell sandbox-proxy to skip CSP injection entirely
      cspMode: effectiveCspMode,
      prefersBorder,
      // SEP-1865 mimetype validation
      mimeType: contentMimeType,
      mimeTypeValid,
      mimeTypeWarning,
    });
  } catch (error) {
    logger.error("[MCP Apps] Error fetching resource", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

export default apps;
