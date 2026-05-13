import { Hono } from "hono";
import { z } from "zod";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";
import { CORS_ORIGINS } from "../../config.js";
import {
  CHATGPT_APPS_SANDBOX_PROXY_HTML,
  MCP_APPS_SANDBOX_PROXY_HTML,
} from "../apps/SandboxProxyHtml.bundled.js";
import {
  injectOpenAICompat,
  injectScripts,
  buildCspHeader,
  buildCspMetaContent,
  buildChatGptRuntimeHead,
  type WidgetCspMeta,
} from "../../utils/widget-helpers.js";
import {
  projectServerSchema,
  withEphemeralConnection,
  handleRoute,
  assertBearerToken,
  ErrorCode,
  WebRouteError,
} from "./auth.js";

const apps = new Hono();

const MCP_APPS_MIMETYPE = RESOURCE_MIME_TYPE;

const LOCALHOST_FRAME_SOURCES = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*",
];

export function buildFrameAncestors(): string {
  const origins = new Set<string>(["'self'", ...LOCALHOST_FRAME_SOURCES]);
  for (const origin of CORS_ORIGINS) {
    if (origin.startsWith("https://")) {
      origins.add(origin);
    }
  }
  return `frame-ancestors ${Array.from(origins).join(" ")}`;
}

function extractHtmlFromResourceContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const record = content as Record<string, unknown>;

  if (typeof record.text === "string") return record.text;
  if (typeof record.blob === "string") {
    return Buffer.from(record.blob, "base64").toString("utf-8");
  }
  return "";
}

// ── Schemas ─────────────────────────────────────────────────────────

// Stage 2.4: extended schema accepts either an MCP Apps `resourceUri`
// (existing path, `_meta.ui.*` discovery) OR an OpenAI Apps SDK
// `openaiOutputTemplate` (`_meta["openai/*"]` discovery). Exactly one
// must be set; sending both is a 400. The legacy `template` field is
// kept for backwards-compat with old clients but ignored when either
// discriminator field is present.
//
// `injectOpenAiCompatRuntime` is a host-side decision passed verbatim
// from the client. The server intentionally does NOT resolve hostStyle
// here — that's the client's job via `resolveOpenAiCompatEnabled`. This
// keeps the four consumers (server inject / advertise / banner / handler
// gating) reading from a single resolver.
//
// Fidelity fields (`toolResponseMetadata`, `locale`, `deviceType`) move
// from the OpenAI-only endpoint to the unified one so the MCPAppsRenderer
// can pass them through to widgets regardless of discovery channel.
const mcpAppsWidgetContentSchema = projectServerSchema.extend({
  resourceUri: z.string().min(1).optional(),
  openaiOutputTemplate: z.string().min(1).optional(),
  toolInput: z.record(z.string(), z.unknown()).default({}),
  toolOutput: z.unknown().optional(),
  toolResponseMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  theme: z.enum(["light", "dark"]).optional(),
  locale: z.string().optional(),
  deviceType: z.enum(["mobile", "tablet", "desktop"]).optional(),
  cspMode: z.enum(["permissive", "widget-declared"]).optional(),
  template: z.string().optional(),
  viewMode: z.string().optional(),
  viewParams: z.record(z.string(), z.unknown()).optional(),
  // Gate set by the client based on `resolveOpenAiCompatEnabled` —
  // never inferred from hostStyle on the server. `undefined` is the
  // legacy default ("don't inject"); the client always passes an
  // explicit boolean from Stage 2 onward.
  injectOpenAiCompatRuntime: z.boolean().optional(),
});

const chatgptAppsWidgetContentSchema = projectServerSchema.extend({
  uri: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()).default({}),
  toolOutput: z.unknown().optional(),
  toolResponseMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  theme: z.enum(["light", "dark"]).optional(),
  cspMode: z.enum(["permissive", "widget-declared"]).optional(),
  locale: z.string().optional(),
  deviceType: z.enum(["mobile", "tablet", "desktop"]).optional(),
});

// ── Sandbox Proxy Routes ─────────────────────────────────────────────

/**
 * Hosted auth exception:
 * These sandbox-proxy HTML routes intentionally do not require bearer auth.
 * They are bootstrap documents for sandboxed iframe runtimes and contain no
 * project/user data by themselves. All data-bearing widget routes remain
 * authenticated POST APIs.
 */
apps.get("/mcp-apps/sandbox-proxy", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Content-Security-Policy", buildFrameAncestors());
  c.res.headers.delete("X-Frame-Options");
  return c.body(MCP_APPS_SANDBOX_PROXY_HTML);
});

apps.get("/chatgpt-apps/sandbox-proxy", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Content-Security-Policy", buildFrameAncestors());
  c.res.headers.delete("X-Frame-Options");
  return c.body(CHATGPT_APPS_SANDBOX_PROXY_HTML);
});

// ── MCP Apps Widget Content ──────────────────────────────────────────

apps.post("/mcp-apps/widget-content", async (c) =>
  withEphemeralConnection(
    c,
    mcpAppsWidgetContentSchema,
    async (manager, body) => {
      // Stage 2.4 discriminator. Exactly one of `resourceUri` /
      // `openaiOutputTemplate` (or the legacy `template`) must be set.
      // Sending both ambiguates the discovery channel — refuse loudly
      // rather than silently picking one.
      const hasResourceUri = !!(body.resourceUri || body.template);
      const hasOpenaiTemplate = !!body.openaiOutputTemplate;
      if (hasResourceUri && hasOpenaiTemplate) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "Specify exactly one of resourceUri or openaiOutputTemplate, not both",
        );
      }
      if (!hasResourceUri && !hasOpenaiTemplate) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "Specify either resourceUri or openaiOutputTemplate",
        );
      }
      if (body.template && !body.template.startsWith("ui://")) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "Template must use ui:// protocol",
        );
      }

      // `openaiOutputTemplate` is the OpenAI Apps SDK discovery channel
      // (free-form URL string written into `_meta["openai/outputTemplate"]`);
      // `resourceUri` is the MCP Apps SEP-1865 channel (`ui://...`).
      const resolvedResourceUri =
        body.template || body.resourceUri || body.openaiOutputTemplate!;
      const isOpenAiDiscovery = hasOpenaiTemplate;
      const effectiveCspMode = body.cspMode ?? "permissive";

      const resourceResult = await manager.readResource(body.serverId, {
        uri: resolvedResourceUri,
      });

      const contents = (resourceResult as any)?.contents || [];
      const content = contents[0];
      if (!content) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "No content in resource",
        );
      }

      const contentMimeType = (content as { mimeType?: string }).mimeType;
      // OpenAI Apps SDK widgets ship `text/html+skybridge` or arbitrary
      // text/html; only enforce the SEP-1865 mimetype for the MCP Apps
      // discovery channel. Otherwise OpenAI-only widgets surface as
      // "invalid mimetype" warnings on every load.
      const mimeTypeValid = isOpenAiDiscovery
        ? true
        : contentMimeType === MCP_APPS_MIMETYPE;
      const mimeTypeWarning =
        !mimeTypeValid && !isOpenAiDiscovery
          ? contentMimeType
            ? `Invalid mimetype "${contentMimeType}" - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
            : `Missing mimetype - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
          : null;

      let html = extractHtmlFromResourceContent(content);
      if (!html) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "No HTML content in resource",
        );
      }

      // Discovery branch split: MCP Apps reads `_meta.ui.*`; OpenAI Apps
      // SDK reads flat `_meta["openai/*"]` keys (widget CSP, prefers-
      // border). The renderer treats both as equivalent inputs to the
      // sandbox proxy — the discriminator only chooses where to look.
      const rawMeta = (content as { _meta?: Record<string, unknown> })._meta;
      const uiMeta = (rawMeta as { ui?: unknown } | undefined)?.ui as
        | {
            csp?: McpUiResourceCsp;
            permissions?: McpUiResourcePermissions;
            prefersBorder?: boolean;
          }
        | undefined;

      type DiscoveredMeta = {
        csp?: McpUiResourceCsp;
        permissions?: McpUiResourcePermissions;
        prefersBorder?: boolean;
      };
      let discovered: DiscoveredMeta;
      if (isOpenAiDiscovery) {
        const openaiCsp = rawMeta?.["openai/widgetCSP"] as
          | McpUiResourceCsp
          | undefined;
        const openaiPrefersBorder = rawMeta?.["openai/widgetPrefersBorder"] as
          | boolean
          | undefined;
        // OpenAI's metadata format has no permissions analogue; widgets
        // declare capabilities via different channels. Pass through as
        // undefined and let the sandbox apply its restrictive default.
        discovered = {
          csp: openaiCsp,
          permissions: undefined,
          prefersBorder: openaiPrefersBorder,
        };
      } else {
        discovered = {
          csp: uiMeta?.csp,
          permissions: uiMeta?.permissions,
          prefersBorder: uiMeta?.prefersBorder,
        };
      }

      // Gate is set by the client based on `resolveOpenAiCompatEnabled`.
      // Server intentionally does not consult hostStyle — keeping the
      // four consumers reading one resolver (see 2.2 docstring).
      // `useLocalStorageWidgetState: true` flips the Stage 1 flag default
      // on once the dispatcher routes OpenAI-SDK widgets through here;
      // the legacy `ui/update-model-context` path is preserved only for
      // the still-existing ChatGPTAppRenderer (deleted in Stage 4).
      if (body.injectOpenAiCompatRuntime) {
        html = injectOpenAICompat(html, {
          toolId: body.toolId,
          toolName: body.toolName,
          toolInput: body.toolInput ?? {},
          toolOutput: body.toolOutput,
          theme: body.theme,
          viewMode: body.viewMode,
          viewParams: body.viewParams,
          useLocalStorageWidgetState: true,
        });
      }

      return {
        html,
        csp: effectiveCspMode === "permissive" ? undefined : discovered.csp,
        permissions: discovered.permissions,
        permissive: effectiveCspMode === "permissive",
        cspMode: effectiveCspMode,
        prefersBorder: discovered.prefersBorder,
        mimeType: contentMimeType,
        mimeTypeValid,
        mimeTypeWarning,
        // Echoed back so the client can correlate which discovery channel
        // produced this payload — useful for the dispatcher's debug
        // overlay and for Stage 3 telemetry separating MCP_APPS vs
        // OPENAI_SDK widgets in the unified renderer.
        discoveryChannel: isOpenAiDiscovery ? "openai" : "mcp-apps",
      };
    },
  ),
);

// ── ChatGPT Apps Widget Content ──────────────────────────────────────

apps.post("/chatgpt-apps/widget-content", async (c) =>
  withEphemeralConnection(
    c,
    chatgptAppsWidgetContentSchema,
    async (manager, body) => {
      const content = await manager.readResource(body.serverId, {
        uri: body.uri,
      });
      const contentsArray = Array.isArray((content as any)?.contents)
        ? (content as any).contents
        : [];
      const firstContent = contentsArray[0];
      if (!firstContent) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "No HTML content found",
        );
      }

      const htmlContent = extractHtmlFromResourceContent(firstContent);
      if (!htmlContent) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "No HTML content found",
        );
      }

      const resourceMeta = firstContent?._meta as
        | Record<string, unknown>
        | undefined;
      const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
        | WidgetCspMeta
        | undefined;
      const effectiveCspMode = body.cspMode ?? "permissive";
      const cspConfig = buildCspHeader(effectiveCspMode, widgetCspRaw, {
        frameAncestors: buildFrameAncestors(),
      });

      const runtimeConfig = {
        toolId: body.toolId,
        toolName: body.toolName,
        toolInput: body.toolInput,
        toolOutput: body.toolOutput ?? null,
        toolResponseMetadata: body.toolResponseMetadata ?? null,
        theme: body.theme ?? "dark",
        locale: body.locale ?? "en-US",
        deviceType: body.deviceType ?? "desktop",
        viewMode: "inline",
        viewParams: {},
        useMapPendingCalls: true,
      };

      const runtimeHeadContent = buildChatGptRuntimeHead({
        htmlContent,
        runtimeConfig,
      });

      // Inject CSP meta tag before scripts for blob URL enforcement in hosted mode.
      // In local mode, CSP is enforced via HTTP headers on the widget-content response.
      // In hosted mode, the HTML is returned as JSON and loaded as a blob URL,
      // which has no HTTP headers. The meta tag provides equivalent enforcement.
      // Per CSP spec, the meta tag should appear before any scripts in <head>.
      let cspMetaTag = "";
      if (cspConfig.headerString) {
        const metaCspContent = buildCspMetaContent(cspConfig.headerString);
        cspMetaTag = `<meta http-equiv="Content-Security-Policy" content="${metaCspContent.replace(/"/g, "&quot;")}">`;
      }

      const modifiedHtml = injectScripts(
        htmlContent,
        cspMetaTag + runtimeHeadContent,
      );

      return {
        html: modifiedHtml,
        csp: {
          mode: cspConfig.mode,
          connectDomains: cspConfig.connectDomains,
          resourceDomains: cspConfig.resourceDomains,
          frameDomains: cspConfig.frameDomains,
          headerString: cspConfig.headerString,
          widgetDeclared: widgetCspRaw ?? null,
        },
        widgetDescription: resourceMeta?.["openai/widgetDescription"] as
          | string
          | undefined,
        prefersBorder:
          (resourceMeta?.["openai/widgetPrefersBorder"] as
            | boolean
            | undefined) ?? true,
        closeWidget:
          (resourceMeta?.["openai/closeWidget"] as boolean | undefined) ??
          false,
      };
    },
  ),
);

// ── File stubs (not supported in hosted mode) ────────────────────────

apps.post("/chatgpt-apps/upload-file", async (c) =>
  handleRoute(c, async () => {
    assertBearerToken(c);
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "File upload is not supported in hosted mode",
    );
  }),
);

apps.get("/chatgpt-apps/file/:id", async (c) =>
  handleRoute(c, async () => {
    assertBearerToken(c);
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "File download is not supported in hosted mode",
    );
  }),
);

export default apps;
