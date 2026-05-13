/**
 * MCP Apps (SEP-1865) Server Routes
 *
 * Provides an endpoint for serving widget HTML.
 * Widgets are expected to use the official SDK (@modelcontextprotocol/ext-apps)
 * which handles JSON-RPC communication with the host.
 */

import { Hono } from "hono";
import "../../../types/hono";
import { logger } from "../../../utils/logger";
import { getRequestLogger } from "../../../utils/request-logger";
import { classifyWidgetError } from "../../../utils/error-classify";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";
import { MCP_APPS_SANDBOX_PROXY_HTML } from "../SandboxProxyHtml.bundled";
import { injectOpenAICompat } from "../../../utils/widget-helpers";
import { readOpenAiDiscoveryMeta } from "../openai-meta-helpers";

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

interface WidgetContentRequest {
  serverId: string;
  // Stage 2.4 discriminator — mirrors the hosted route at
  // server/routes/web/apps.ts so the same fetcher can drive either
  // deployment. Exactly one of `resourceUri` (MCP Apps SEP-1865,
  // `_meta.ui.*` discovery) or `openaiOutputTemplate` (OpenAI Apps SDK,
  // `_meta["openai/*"]` discovery) must be set.
  resourceUri?: string;
  openaiOutputTemplate?: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolResponseMetadata?: Record<string, unknown> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  locale?: string;
  deviceType?: "mobile" | "tablet" | "desktop";
  cspMode?: CspMode;
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
  injectOpenAiCompatRuntime?: boolean;
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
      openaiOutputTemplate,
      toolInput,
      toolOutput,
      toolResponseMetadata,
      toolId,
      toolName,
      theme,
      locale,
      deviceType,
      cspMode,
      template: templateUri,
      viewMode,
      viewParams,
      injectOpenAiCompatRuntime,
    } = body;

    if (!serverId || !toolId || !toolName) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    const hasResourceUri = !!(resourceUri || templateUri);
    const hasOpenaiTemplate = !!openaiOutputTemplate;
    if (hasResourceUri && hasOpenaiTemplate) {
      return c.json(
        {
          error:
            "Specify exactly one of resourceUri or openaiOutputTemplate, not both",
        },
        400,
      );
    }
    if (!hasResourceUri && !hasOpenaiTemplate) {
      return c.json(
        { error: "Specify either resourceUri or openaiOutputTemplate" },
        400,
      );
    }
    if (templateUri && !templateUri.startsWith("ui://")) {
      return c.json({ error: "Template must use ui:// protocol" }, 400);
    }

    const isOpenAiDiscovery = hasOpenaiTemplate;
    const resolvedResourceUri =
      templateUri || resourceUri || openaiOutputTemplate!;

    const effectiveCspMode = cspMode ?? "permissive";
    const mcpClientManager = c.mcpClientManager;

    // REUSE existing mcpClientManager.readResource (same as resources.ts)
    const resourceResult = await mcpClientManager.readResource(serverId, {
      uri: resolvedResourceUri,
    });

    // Extract HTML from resource contents
    const contents = resourceResult?.contents || [];
    const content = contents[0];

    if (!content) {
      getRequestLogger(c, "routes.apps.mcp-apps").event("widget.resource.failed", {
        widgetType: "mcp_apps",
        resourceUri: resolvedResourceUri,
        cspMode: effectiveCspMode,
        errorCode: classifyWidgetError(null, "resource_missing"),
      });
      return c.json({ error: "No content in resource" }, 404);
    }

    // SEP-1865: Validate mimetype - MUST be "text/html;profile=mcp-app"
    // for the MCP Apps discovery channel. OpenAI Apps SDK widgets ship
    // `text/html+skybridge` or arbitrary `text/html` and aren't subject
    // to the SEP-1865 mimetype profile — skip enforcement for them so
    // those widgets don't surface as "invalid mimetype" on every load.
    const contentMimeType = (content as { mimeType?: string }).mimeType;
    const mimeTypeValid = isOpenAiDiscovery
      ? true
      : contentMimeType === MCP_APPS_MIMETYPE;
    const mimeTypeWarning =
      !mimeTypeValid && !isOpenAiDiscovery
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
      getRequestLogger(c, "routes.apps.mcp-apps").event("widget.resource.failed", {
        widgetType: "mcp_apps",
        resourceUri: resolvedResourceUri,
        cspMode: effectiveCspMode,
        errorCode: classifyWidgetError(null, "html_missing"),
      });
      return c.json({ error: "No HTML content in resource" }, 404);
    }

    // Discovery branch split (Stage 2.4). MCP Apps reads `_meta.ui.*`;
    // OpenAI Apps SDK reads flat `_meta["openai/*"]` keys. The sandbox
    // proxy treats both as equivalent inputs — the discriminator only
    // chooses where to look.
    const rawMeta = (content as { _meta?: Record<string, unknown> })._meta;
    const uiMeta = (rawMeta as { ui?: UIResourceMeta } | undefined)?.ui;
    let csp: McpUiResourceCsp | undefined;
    let permissions: McpUiResourcePermissions | undefined;
    let prefersBorder: boolean | undefined;
    if (isOpenAiDiscovery) {
      // Snake_case → camelCase translation lives in the shared
      // `openai-meta-helpers` module — same path the hosted route
      // uses, so the two deployments can't drift.
      const openai = readOpenAiDiscoveryMeta(rawMeta);
      csp = openai.csp;
      // OpenAI's metadata format has no permissions analogue; widgets
      // declare capabilities via other channels. Leave undefined so the
      // sandbox applies its restrictive default.
      permissions = undefined;
      prefersBorder = openai.prefersBorder;
    } else {
      csp = uiMeta?.csp;
      permissions = uiMeta?.permissions;
      prefersBorder = uiMeta?.prefersBorder;
    }

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

    // Stage 2: gate on the client-supplied flag (resolved via
    // `resolveOpenAiCompatEnabled` in the renderer). Server does not
    // consult hostStyle. `useLocalStorageWidgetState: true` flips the
    // Stage 1 flag default for any widget routed through here; the
    // legacy `ui/update-model-context` path stays in
    // `ChatGPTAppRenderer` until Stage 4. The fidelity fields are
    // forwarded into the runtime config so widgets reading
    // `window.openai.toolResponseMetadata/locale/deviceType` see the
    // same values they did via the legacy ChatGPT inject path.
    // Default to `true` when omitted — matches the pre-Stage-2
    // unconditional behavior so pre-Stage-2 callers don't silently lose
    // `window.openai`. Stage 2 dispatcher sends explicit `false` only
    // for OpenAI-discovery widgets with `enabled: false`.
    if (injectOpenAiCompatRuntime !== false) {
      html = injectOpenAICompat(html, {
        toolId,
        toolName,
        toolInput: toolInput ?? {},
        toolOutput,
        toolResponseMetadata: toolResponseMetadata ?? null,
        theme,
        locale,
        deviceType,
        viewMode,
        viewParams,
        useLocalStorageWidgetState: true,
      });
    }

    // Return JSON with HTML and metadata for CSP enforcement
    getRequestLogger(c, "routes.apps.mcp-apps").event("widget.resource.served", {
      widgetType: "mcp_apps",
      resourceUri: resolvedResourceUri,
      cspMode: effectiveCspMode,
      mimeTypeValid,
    });
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
      // Echoed for the dispatcher's debug overlay / Stage 3 telemetry.
      discoveryChannel: isOpenAiDiscovery ? "openai" : "mcp-apps",
    });
  } catch (error) {
    getRequestLogger(c, "routes.apps.mcp-apps").event("widget.resource.failed", {
      widgetType: "mcp_apps",
      errorCode: classifyWidgetError(error),
    });
    logger.error("[MCP Apps] Error fetching resource", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});

apps.get("/sandbox-proxy", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header(
    "Content-Security-Policy",
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  );
  c.res.headers.delete("X-Frame-Options");
  return c.body(MCP_APPS_SANDBOX_PROXY_HTML);
});

export default apps;
