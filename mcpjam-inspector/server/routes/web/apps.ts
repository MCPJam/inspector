import { Hono } from "hono";
import { z } from "zod";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";
import { CORS_ORIGINS } from "../../config.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  CHATGPT_APPS_SANDBOX_PROXY_HTML,
  MCP_APPS_SANDBOX_PROXY_HTML,
} from "../apps/SandboxProxyHtml.bundled.js";
import {
  injectOpenAICompat,
  injectScripts,
  buildCspHeader,
  buildChatGptRuntimeHead,
  type CspMode,
  type WidgetCspMeta,
} from "../../utils/widget-helpers.js";
import {
  buildSingleServerOAuthTokens,
  createAuthorizedManager,
  withManager,
  handleRoute,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
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

// ── Sandbox Proxy Routes ─────────────────────────────────────────────

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

type MpcAppsWidgetBody = {
  workspaceId: string;
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
};

apps.post("/mcp-apps/widget-content", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      z.object({
        workspaceId: z.string().min(1),
        serverId: z.string().min(1),
        resourceUri: z.string().min(1),
        toolInput: z.record(z.string(), z.unknown()).default({}),
        toolOutput: z.unknown().optional(),
        toolId: z.string().min(1),
        toolName: z.string().min(1),
        theme: z.enum(["light", "dark"]).optional(),
        cspMode: z.enum(["permissive", "widget-declared"]).optional(),
        template: z.string().optional(),
        viewMode: z.string().optional(),
        viewParams: z.record(z.string(), z.unknown()).optional(),
        oauthAccessToken: z.string().optional(),
      }),
      await readJsonBody<unknown>(c),
    ) as MpcAppsWidgetBody & { oauthAccessToken?: string };

    if (body.template && !body.template.startsWith("ui://")) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Template must use ui:// protocol",
      );
    }

    const resolvedResourceUri = body.template || body.resourceUri;
    const effectiveCspMode = body.cspMode ?? "widget-declared";

    const oauthTokens = buildSingleServerOAuthTokens(
      body.serverId,
      body.oauthAccessToken,
    );

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const resourceResult = await manager.readResource(body.serverId, {
          uri: resolvedResourceUri,
        });

        const contents = (resourceResult as any)?.contents || [];
        const content = contents[0];
        if (!content) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No content in resource");
        }

        const contentMimeType = (content as { mimeType?: string }).mimeType;
        const mimeTypeValid = contentMimeType === MCP_APPS_MIMETYPE;
        const mimeTypeWarning = !mimeTypeValid
          ? contentMimeType
            ? `Invalid mimetype "${contentMimeType}" - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
            : `Missing mimetype - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
          : null;

        let html = extractHtmlFromResourceContent(content);
        if (!html) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No HTML content in resource");
        }

        const uiMeta = (content._meta as { ui?: any } | undefined)?.ui as
          | {
              csp?: McpUiResourceCsp;
              permissions?: McpUiResourcePermissions;
              prefersBorder?: boolean;
            }
          | undefined;

        html = injectOpenAICompat(html, {
          toolId: body.toolId,
          toolName: body.toolName,
          toolInput: body.toolInput ?? {},
          toolOutput: body.toolOutput,
          theme: body.theme,
          viewMode: body.viewMode,
          viewParams: body.viewParams,
        });

        return {
          html,
          csp: effectiveCspMode === "permissive" ? undefined : uiMeta?.csp,
          permissions: uiMeta?.permissions,
          permissive: effectiveCspMode === "permissive",
          cspMode: effectiveCspMode,
          prefersBorder: uiMeta?.prefersBorder,
          mimeType: contentMimeType,
          mimeTypeValid,
          mimeTypeWarning,
        };
      },
    );
  }),
);

// ── ChatGPT Apps Widget Content ──────────────────────────────────────

type ChatGptWidgetBody = {
  workspaceId: string;
  serverId: string;
  uri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolResponseMetadata?: Record<string, unknown> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: CspMode;
  locale?: string;
  deviceType?: "mobile" | "tablet" | "desktop";
};

apps.post("/chatgpt-apps/widget-content", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      z.object({
        workspaceId: z.string().min(1),
        serverId: z.string().min(1),
        uri: z.string().min(1),
        toolInput: z.record(z.string(), z.unknown()).default({}),
        toolOutput: z.unknown().optional(),
        toolResponseMetadata: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional(),
        toolId: z.string().min(1),
        toolName: z.string().min(1),
        theme: z.enum(["light", "dark"]).optional(),
        cspMode: z.enum(["permissive", "widget-declared"]).optional(),
        locale: z.string().optional(),
        deviceType: z.enum(["mobile", "tablet", "desktop"]).optional(),
        oauthAccessToken: z.string().optional(),
      }),
      await readJsonBody<unknown>(c),
    ) as ChatGptWidgetBody & { oauthAccessToken?: string };

    const oauthTokens = buildSingleServerOAuthTokens(
      body.serverId,
      body.oauthAccessToken,
    );

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const content = await manager.readResource(body.serverId, {
          uri: body.uri,
        });
        const contentsArray = Array.isArray((content as any)?.contents)
          ? (content as any).contents
          : [];
        const firstContent = contentsArray[0];
        if (!firstContent) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No HTML content found");
        }

        const htmlContent = extractHtmlFromResourceContent(firstContent);
        if (!htmlContent) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No HTML content found");
        }

        const resourceMeta = firstContent?._meta as Record<string, unknown> | undefined;
        const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
          | WidgetCspMeta
          | undefined;
        const effectiveCspMode = body.cspMode ?? "widget-declared";
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

        const modifiedHtml = injectScripts(htmlContent, runtimeHeadContent);

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
            (resourceMeta?.["openai/widgetPrefersBorder"] as boolean | undefined) ??
            true,
          closeWidget:
            (resourceMeta?.["openai/closeWidget"] as boolean | undefined) ??
            false,
        };
      },
    );
  }),
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
