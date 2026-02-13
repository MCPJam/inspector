/**
 * MCP Apps (SEP-1865) Server Routes
 *
 * Provides an endpoint for serving widget HTML.
 * Widgets are expected to use the official SDK (@modelcontextprotocol/ext-apps)
 * which handles JSON-RPC communication with the host.
 */

import { Hono } from "hono";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "../../../types/hono";
import { logger } from "../../../utils/logger";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";
import { MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT } from "./McpAppsOpenAICompatibleRuntime.bundled";

const apps = new Hono();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── OpenAI compat injection helpers ─────────────────────────────────

/**
 * Escape characters that could break inline <script> content.
 * Same approach as chatgpt.ts serializeForInlineScript.
 */
const serializeForInlineScript = (value: unknown) =>
  JSON.stringify(value ?? null)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * Inject the OpenAI compatibility runtime into MCP App HTML.
 * Adds a JSON config element + the bundled IIFE script into <head>.
 * If no <head> tag exists, wraps the content in a full HTML document.
 */
function injectOpenAICompat(
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
  // Escape </ sequences to prevent a literal "</script>" in the bundled code
  // from prematurely closing the tag (XSS vector). In JS, \/ is just /.
  const escapedRuntime = MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT.replace(
    /<\//g,
    "<\\/",
  );
  const runtimeScript = `<script>${escapedRuntime}</script>`;
  const headContent = `${configScript}${runtimeScript}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${headContent}`);
  }
  // No <head> tag — wrap in a full HTML document
  return `<!DOCTYPE html><html><head>${headContent}<meta charset="UTF-8"></head><body>${html}</body></html>`;
}

/**
 * SEP-1865 mandated mimetype for MCP Apps
 * @see https://github.com/anthropics/anthropic-cookbook/blob/main/misc/sep-1865-mcp-apps.md
 */
const MCP_APPS_MIMETYPE = RESOURCE_MIME_TYPE;

/**
 * CSP mode types - matches client-side CspMode type
 */
type CspMode = "permissive" | "widget-declared";

interface WidgetContentRequest {
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: CspMode;
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
}

// UI Resource metadata per SEP-1865 (using SDK types)
interface UIResourceMeta {
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  domain?: string;
  prefersBorder?: boolean;
}

// Serve widget content with CSP metadata (SEP-1865)
apps.post("/widget-content", async (c) => {
  try {
    const body = (await c.req.json()) as Partial<WidgetContentRequest>;
    const {
      serverId,
      resourceUri,
      toolInput,
      toolOutput,
      toolId,
      toolName,
      theme,
      cspMode,
      template: templateUri,
      viewMode,
      viewParams,
    } = body;

    if (!serverId || !resourceUri || !toolId || !toolName) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    if (templateUri && !templateUri.startsWith("ui://")) {
      return c.json({ error: "Template must use ui:// protocol" }, 400);
    }

    const resolvedResourceUri = templateUri || resourceUri;

    const effectiveCspMode = cspMode ?? "widget-declared";
    const mcpClientManager = c.mcpClientManager;

    // REUSE existing mcpClientManager.readResource (same as resources.ts)
    const resourceResult = await mcpClientManager.readResource(serverId, {
      uri: resolvedResourceUri,
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
        resourceUri: resolvedResourceUri,
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

    // Extract CSP, permissions, and other UI metadata from resource _meta (SEP-1865)
    const uiMeta = (content._meta as { ui?: UIResourceMeta } | undefined)?.ui;
    const csp = uiMeta?.csp;
    const permissions = uiMeta?.permissions;
    const prefersBorder = uiMeta?.prefersBorder;

    // Log CSP and permissions configuration for security review (SEP-1865)
    logger.debug("[MCP Apps] Security configuration", {
      resourceUri: resolvedResourceUri,
      effectiveCspMode,
      widgetDeclaredCsp: csp
        ? {
            connectDomains: csp.connectDomains || [],
            resourceDomains: csp.resourceDomains || [],
            frameDomains: csp.frameDomains || [],
            baseUriDomains: csp.baseUriDomains || [],
          }
        : null,
      widgetDeclaredPermissions: permissions
        ? {
            camera: permissions.camera !== undefined,
            microphone: permissions.microphone !== undefined,
            geolocation: permissions.geolocation !== undefined,
            clipboardWrite: permissions.clipboardWrite !== undefined,
          }
        : null,
    });

    // When in permissive mode, skip CSP entirely (for testing/debugging)
    // When in widget-declared mode, use the widget's CSP metadata (or restrictive defaults)
    const isPermissive = effectiveCspMode === "permissive";

    // Inject window.openai compat layer into every MCP App iframe
    html = injectOpenAICompat(html, {
      toolId,
      toolName,
      toolInput: toolInput ?? {},
      toolOutput,
      theme,
      viewMode,
      viewParams,
    });

    // Return JSON with HTML and metadata for CSP enforcement
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.json({
      html,
      csp: isPermissive ? undefined : csp,
      permissions, // Include permissions metadata
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

apps.get("/sandbox-proxy", (c) => {
  const html = readFileSync(join(__dirname, "sandbox-proxy.html"), "utf-8");
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header(
    "Content-Security-Policy",
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  );
  c.res.headers.delete("X-Frame-Options");
  return c.body(html);
});

export default apps;
