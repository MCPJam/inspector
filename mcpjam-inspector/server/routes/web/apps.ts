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
  normalizeWidgetCspMeta,
  type CspMode,
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

/**
 * Hosted-mode mirror of `extractLegacyOpenAICsp` in
 * routes/apps/mcp-apps/index.ts. Reads the legacy Apps SDK CSP shape
 * (`_meta["openai/widgetCSP"]` with snake_case fields) and returns the
 * camelCase `McpUiResourceCsp` the proxy expects, or undefined when no
 * legacy CSP is present.
 */
function extractLegacyOpenAICspHosted(
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

// Mimetypes accepted by the hosted-mode widget-content route. Mirrors
// the local route in routes/apps/mcp-apps/index.ts — see the long-form
// comment there for rationale (SEP-1865 canonical + two legacy Apps SDK
// forms, kept for backward compat with widgets that worked on the old
// ChatGPTAppRenderer path).
const SKYBRIDGE_MIMETYPE = "text/html+skybridge";
const PLAIN_HTML_MIMETYPE = "text/html";
const ACCEPTED_WIDGET_MIMETYPES = new Set<string>([
  MCP_APPS_MIMETYPE,
  SKYBRIDGE_MIMETYPE,
  PLAIN_HTML_MIMETYPE,
]);

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

const mcpAppsWidgetContentSchema = projectServerSchema.extend({
  resourceUri: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()).default({}),
  toolOutput: z.unknown().optional(),
  toolResponseMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
  initialWidgetState: z.unknown().optional(),
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  theme: z.enum(["light", "dark"]).optional(),
  cspMode: z.enum(["permissive", "widget-declared"]).optional(),
  template: z.string().optional(),
  viewMode: z.string().optional(),
  viewParams: z.record(z.string(), z.unknown()).optional(),
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
      if (body.template && !body.template.startsWith("ui://")) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "Template must use ui:// protocol",
        );
      }

      const resolvedResourceUri = body.template || body.resourceUri;
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
      const mimeTypeValid =
        typeof contentMimeType === "string" &&
        ACCEPTED_WIDGET_MIMETYPES.has(contentMimeType);
      const mimeTypeWarning = !mimeTypeValid
        ? contentMimeType
          ? `Invalid mimetype "${contentMimeType}" - expected one of: ${[...ACCEPTED_WIDGET_MIMETYPES].join(", ")}`
          : `Missing mimetype - expected one of: ${[...ACCEPTED_WIDGET_MIMETYPES].join(", ")}`
        : null;

      let html = extractHtmlFromResourceContent(content);
      if (!html) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "No HTML content in resource",
        );
      }

      const resourceMeta = content._meta as
        | Record<string, unknown>
        | undefined;
      const uiMeta = (resourceMeta as { ui?: any } | undefined)?.ui as
        | {
            csp?: McpUiResourceCsp;
            permissions?: McpUiResourcePermissions;
            prefersBorder?: boolean;
          }
        | undefined;
      // Apps SDK widgets declare CSP under _meta["openai/widgetCSP"]
      // (snake_case) and border preference under
      // _meta["openai/widgetPrefersBorder"]. Fall back to those so the
      // consolidated path renders legacy widgets with their declared
      // origins and border preference. Mirrors routes/apps/mcp-apps/index.ts.
      const cspFromMeta: McpUiResourceCsp | undefined =
        uiMeta?.csp ?? extractLegacyOpenAICspHosted(resourceMeta);
      const prefersBorderFromMeta: boolean | undefined =
        uiMeta?.prefersBorder ??
        (typeof resourceMeta?.["openai/widgetPrefersBorder"] === "boolean"
          ? (resourceMeta["openai/widgetPrefersBorder"] as boolean)
          : undefined);

      html = injectOpenAICompat(html, {
        toolId: body.toolId,
        toolName: body.toolName,
        toolInput: body.toolInput ?? {},
        toolOutput: body.toolOutput,
        toolResponseMetadata: body.toolResponseMetadata ?? null,
        initialWidgetState: body.initialWidgetState ?? null,
        theme: body.theme,
        viewMode: body.viewMode,
        viewParams: body.viewParams,
      });

      return {
        html,
        csp: effectiveCspMode === "permissive" ? undefined : cspFromMeta,
        permissions: uiMeta?.permissions,
        permissive: effectiveCspMode === "permissive",
        cspMode: effectiveCspMode,
        prefersBorder: prefersBorderFromMeta,
        mimeType: contentMimeType,
        mimeTypeValid,
        mimeTypeWarning,
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
      const widgetCspRaw = normalizeWidgetCspMeta(resourceMeta);
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
          ((resourceMeta?.ui as { prefersBorder?: boolean } | undefined)
            ?.prefersBorder as boolean | undefined) ??
          (resourceMeta?.["openai/widgetPrefersBorder"] as
            | boolean
            | undefined) ??
          true,
        closeWidget:
          (resourceMeta?.["openai/closeWidget"] as boolean | undefined) ??
          false,
      };
    },
  ),
);

// ── File stubs (not supported in hosted mode) ────────────────────────
// Canonical `/files/*` plus legacy `/chatgpt-apps/*` aliases. The client
// short-circuits hosted-mode uploads/downloads before hitting the server
// (see client widget-file-messages.ts), so these are belt-and-suspenders.
// Drop the chatgpt-apps aliases in Phase 4.

const fileUploadStub = async (c: any) =>
  handleRoute(c, async () => {
    assertBearerToken(c);
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "File upload is not supported in hosted mode",
    );
  });

const fileDownloadStub = async (c: any) =>
  handleRoute(c, async () => {
    assertBearerToken(c);
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "File download is not supported in hosted mode",
    );
  });

apps.post("/files/upload-file", fileUploadStub);
apps.get("/files/file/:fileId", fileDownloadStub);

apps.post("/chatgpt-apps/upload-file", fileUploadStub);
apps.get("/chatgpt-apps/file/:id", fileDownloadStub);

export default apps;
