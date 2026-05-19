import { Hono } from "hono";
import "../../../types/hono";
import { logger } from "../../../utils/logger";
import { CHATGPT_APPS_SANDBOX_PROXY_HTML } from "../SandboxProxyHtml.bundled";
import widgetFiles from "../shared/widget-files";
import {
  buildChatGptRuntimeHead,
  injectScripts,
  buildCspHeader,
  normalizeWidgetCspMeta,
  type CspMode,
} from "../../../utils/widget-helpers";

const chatgpt = new Hono();

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

// File upload/download (storage, validation, cleanup) lives in
// ../shared/widget-files. Mounted onto this router below for back-compat
// while the legacy ChatGPTAppRenderer path is alive; see ../index.ts for
// the canonical `/api/apps/files/*` mount.
chatgpt.route("/", widgetFiles);

// Cleanup expired widget data every 5 minutes. (File-store cleanup lives
// in the shared widget-files module.)
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
      cspMode: cspMode ?? "permissive", // CSP enforcement mode (permissive by default)
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
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  // Allow cross-origin framing between localhost and 127.0.0.1 for triple-iframe architecture
  c.header(
    "Content-Security-Policy",
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  );
  // Remove X-Frame-Options as it doesn't support multiple origins (CSP takes precedence)
  c.res.headers.delete("X-Frame-Options");
  return c.body(CHATGPT_APPS_SANDBOX_PROXY_HTML);
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

    // ChatGPT now supports the standard MCP Apps `_meta.ui.csp` field.
    // Normalize it into the legacy snake_case shape expected by this
    // compatibility route, falling back to `openai/widgetCSP` for older apps.
    const resourceMeta = firstContent?._meta as
      | Record<string, unknown>
      | undefined;
    const widgetCspRaw = normalizeWidgetCspMeta(resourceMeta);

    // Build CSP configuration based on mode
    const cspConfig = buildCspHeader(cspMode ?? "permissive", widgetCspRaw);

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
      buildChatGptRuntimeHead({
        htmlContent,
        runtimeConfig: runtimeConfig as unknown as Record<string, unknown>,
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
        ((resourceMeta?.ui as { prefersBorder?: boolean } | undefined)
          ?.prefersBorder as boolean | undefined) ??
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
  const response = await fetch('/api/apps/chatgpt-apps/widget-content/${toolId}' + searchParams);
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

    // ChatGPT now supports the standard MCP Apps `_meta.ui.csp` field.
    // Normalize it into the legacy snake_case shape expected by this
    // compatibility route, falling back to `openai/widgetCSP` for older apps.
    const resourceMeta = firstContent?._meta as
      | Record<string, unknown>
      | undefined;
    const widgetCspRaw = normalizeWidgetCspMeta(resourceMeta);

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
      buildChatGptRuntimeHead({
        htmlContent,
        runtimeConfig: runtimeConfig as unknown as Record<string, unknown>,
        baseHref: "/",
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
