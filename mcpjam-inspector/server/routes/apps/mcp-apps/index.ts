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

const apps = new Hono();

/**
 * SEP-1865 mandated mimetype for MCP Apps
 * @see https://github.com/anthropics/anthropic-cookbook/blob/main/misc/sep-1865-mcp-apps.md
 */
const MCP_APPS_MIMETYPE = RESOURCE_MIME_TYPE;

/**
 * Mimetypes accepted by the unified widget-content route.
 *
 * - `text/html;profile=mcp-app` — SEP-1865 canonical.
 * - `text/html+skybridge` — legacy Apps SDK mimetype shipped by ChatGPT
 *   apps (see examples/chatgpt-apps/CoffeeShop/server.ts).
 * - `text/html` — older Apps SDK / hand-rolled widgets that just declare
 *   plain HTML. The legacy ChatGPTAppRenderer accepted these without any
 *   mimetype check; we mirror that for backward compatibility.
 *
 * Anything else triggers a hard load error so a misconfigured resource
 * doesn't silently render the wrong content type. The renderer surfaces a
 * warning for the two non-canonical forms but still renders the content.
 */
const SKYBRIDGE_MIMETYPE = "text/html+skybridge";
const PLAIN_HTML_MIMETYPE = "text/html";
const ACCEPTED_WIDGET_MIMETYPES = new Set<string>([
  MCP_APPS_MIMETYPE,
  SKYBRIDGE_MIMETYPE,
  PLAIN_HTML_MIMETYPE,
]);

/**
 * CSP mode types - matches client-side CspMode type
 */
type CspMode = "permissive" | "widget-declared";

interface WidgetContentRequest {
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  /**
   * Tool response `_meta` (Apps SDK contract). When present, the compat
   * runtime exposes it as `window.openai.toolResponseMetadata` so widgets
   * can read timestamps / source IDs without digging into toolOutput.
   */
  toolResponseMetadata?: Record<string, unknown> | null;
  /**
   * Persisted widget state from a saved view or fork. Seeds
   * `window.openai.widgetState` in the compat runtime so widgets boot
   * in the previously-saved state rather than fresh defaults.
   */
  initialWidgetState?: unknown;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: CspMode;
  /**
   * When true, injects the OpenAI Apps SDK `window.openai` shim into
   * the widget HTML before returning it. Default `false` — only hosts
   * that emulate ChatGPT/Copilot or MCPJam's dev surface should opt in.
   * The flag is resolved client-side from the active host config's
   * `mcpProfile.apps.compatRuntime` (with host style preset fallback)
   * so absent / non-boolean payloads here mean "no shim".
   */
  injectOpenAiCompat?: boolean;
  /**
   * Resolved per-method `window.openai.*` capability surface. Caller
   * (client renderer) computes this from the active host config's
   * preset + override stack and forwards it verbatim. The local server
   * route does NOT resolve from a hostConfig — it doesn't own one —
   * so missing payloads here mean "use the SDK runtime's default full
   * surface", preserving legacy behavior.
   *
   * When present, methods whose capability resolves false will be
   * absent on `window.openai` in the widget (feature-detection truth).
   */
  openAiCompatCapabilities?: Record<string, unknown>;
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

/**
 * Fallback CSP extraction for legacy Apps SDK widgets that declare CSP
 * via `_meta["openai/widgetCSP"]` (snake_case fields:
 * `connect_domains`, `resource_domains`, `frame_domains`) instead of the
 * SEP-1865 `_meta.ui.csp` shape (camelCase). Returns the camelCase shape
 * the proxy's buildCSP expects, or undefined when no legacy CSP is set
 * or only contains non-array values.
 */
function extractLegacyOpenAICsp(
  resourceMeta: Record<string, unknown> | undefined,
): McpUiResourceCsp | undefined {
  if (!resourceMeta) return undefined;
  const legacy = resourceMeta["openai/widgetCSP"];
  if (!legacy || typeof legacy !== "object") return undefined;
  const src = legacy as Record<string, unknown>;
  const readArr = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.length > 0)
      : undefined;
  const out: McpUiResourceCsp = {};
  const connect = readArr(src.connect_domains);
  const resource = readArr(src.resource_domains);
  const frame = readArr(src.frame_domains);
  if (connect && connect.length > 0) out.connectDomains = connect;
  if (resource && resource.length > 0) out.resourceDomains = resource;
  if (frame && frame.length > 0) out.frameDomains = frame;
  return Object.keys(out).length > 0 ? out : undefined;
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
      toolResponseMetadata,
      initialWidgetState,
      toolId,
      toolName,
      theme,
      cspMode,
      template: templateUri,
      viewMode,
      viewParams,
      injectOpenAiCompat,
      openAiCompatCapabilities,
    } = body;

    if (!serverId || !resourceUri || !toolId || !toolName) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    if (templateUri && !templateUri.startsWith("ui://")) {
      return c.json({ error: "Template must use ui:// protocol" }, 400);
    }

    const resolvedResourceUri = templateUri || resourceUri;

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

    // Accept the SEP-1865 canonical mimetype plus the two legacy Apps SDK
    // forms (`text/html+skybridge` and plain `text/html`) so widgets that
    // worked on the old ChatGPTAppRenderer path keep rendering through
    // the consolidated MCP path. Anything else is a hard error.
    const contentMimeType = (content as { mimeType?: string }).mimeType;
    const mimeTypeValid =
      typeof contentMimeType === "string" &&
      ACCEPTED_WIDGET_MIMETYPES.has(contentMimeType);
    const mimeTypeWarning = !mimeTypeValid
      ? contentMimeType
        ? `Invalid mimetype "${contentMimeType}" - expected one of: ${[...ACCEPTED_WIDGET_MIMETYPES].join(", ")}`
        : `Missing mimetype - expected one of: ${[...ACCEPTED_WIDGET_MIMETYPES].join(", ")}`
      : contentMimeType !== MCP_APPS_MIMETYPE
        ? `Legacy Apps SDK mimetype "${contentMimeType}" — SEP-1865 prefers "${MCP_APPS_MIMETYPE}"`
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

    // Extract CSP, permissions, and other UI metadata from resource _meta.
    // SEP-1865 keys (`_meta.ui.csp`, `_meta.ui.prefersBorder`) are
    // canonical; fall back to the legacy Apps SDK keys
    // (`_meta["openai/widgetCSP"]`, `_meta["openai/widgetPrefersBorder"]`)
    // when SEP-1865 keys are absent so widgets that haven't migrated still
    // get their declared CSP/border preference honored.
    const resourceMeta = content._meta as Record<string, unknown> | undefined;
    const uiMeta = (resourceMeta as { ui?: UIResourceMeta } | undefined)?.ui;
    const csp: McpUiResourceCsp | undefined =
      uiMeta?.csp ?? extractLegacyOpenAICsp(resourceMeta);
    const permissions = uiMeta?.permissions;
    const prefersBorder: boolean | undefined =
      uiMeta?.prefersBorder ??
      (typeof resourceMeta?.["openai/widgetPrefersBorder"] === "boolean"
        ? (resourceMeta["openai/widgetPrefersBorder"] as boolean)
        : undefined);

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

    // Optionally inject the OpenAI Apps SDK `window.openai` shim.
    // Claude/Cursor/Codex-style hosts leave this surface off; ChatGPT/
    // Copilot and MCPJam's dev surface opt in. The renderer resolves
    // the flag from the active host config and forwards it here, so the
    // injection decision travels with the request rather than living on
    // the server.
    const shouldInjectOpenAiCompat = injectOpenAiCompat === true;
    if (shouldInjectOpenAiCompat) {
      html = injectOpenAICompat(html, {
        toolId,
        toolName,
        toolInput: toolInput ?? {},
        toolOutput,
        toolResponseMetadata: toolResponseMetadata ?? null,
        initialWidgetState: initialWidgetState ?? null,
        theme,
        viewMode,
        viewParams,
        // Cast: the wire body declares `Record<string, unknown>` for
        // forward compatibility (server doesn't structurally validate
        // the matrix here — the SDK runtime accepts a sparse partial
        // and fills in defaults). Type-checking happens client-side.
        capabilities: openAiCompatCapabilities as
          | Parameters<typeof injectOpenAICompat>[1]["capabilities"]
          | undefined,
      });
    }

    // Return JSON with HTML and metadata for CSP enforcement
    getRequestLogger(c, "routes.apps.mcp-apps").event("widget.resource.served", {
      widgetType: "mcp_apps",
      resourceUri: resolvedResourceUri,
      cspMode: effectiveCspMode,
      injectedOpenAiCompat: shouldInjectOpenAiCompat,
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
      // Echoed for trace clarity. The renderer's reload-key already
      // uses the flag it sent (not this echoed value), but persisting
      // the server-confirmed value alongside cached HTML makes saved
      // views unambiguous about their contents.
      injectedOpenAiCompat: shouldInjectOpenAiCompat,
      // Per plan §6.5: replay/debug needs to know *which* surface was
      // injected, not just yes/no. Echo the capability record alongside
      // the boolean so saved views are self-describing. Absent when
      // injection was off or when no capabilities were passed (legacy
      // call sites — defaults to full surface, which is implied).
      injectedOpenAiCompatCapabilities:
        shouldInjectOpenAiCompat && openAiCompatCapabilities !== undefined
          ? openAiCompatCapabilities
          : undefined,
      // SEP-1865 mimetype validation
      mimeType: contentMimeType,
      mimeTypeValid,
      mimeTypeWarning,
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
