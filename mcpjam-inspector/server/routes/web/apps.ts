import { Hono } from "hono";
import { z } from "zod";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";
import { CORS_ORIGINS } from "../../config.js";
import { MCP_APPS_SANDBOX_PROXY_HTML } from "../apps/SandboxProxyHtml.bundled.js";
import { RECORDER_SHIM_JS } from "../apps/mcp-apps/recorder-shim.js";
import { injectOpenAICompat } from "../../utils/widget-helpers.js";
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
const SANDBOX_PROXY_HTML_WITH_RECORDER = MCP_APPS_SANDBOX_PROXY_HTML.replace(
  '"__MCPJAM_RECORDER_SHIM__"',
  () => JSON.stringify(RECORDER_SHIM_JS),
);

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
// forms).
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
  // Default false: Claude/Cursor/Codex-style hosts don't expose
  // `window.openai`. ChatGPT/Copilot and MCPJam dev host configs flip
  // this on per request via the resolver in the renderer.
  injectOpenAiCompat: z.boolean().optional().default(false),
  // Per-method `window.openai.*` capability surface — client-resolved
  // and forwarded verbatim. The hosted server doesn't own the active
  // host config (capability resolution stays client-side), so this is
  // a passthrough into `injectOpenAICompat`. `z.unknown()` because the
  // SDK runtime accepts a sparse partial — strict validation lives on
  // the client where the type is known.
  openAiCompatCapabilities: z.record(z.string(), z.unknown()).optional(),
  template: z.string().optional(),
  viewMode: z.string().optional(),
  viewParams: z.record(z.string(), z.unknown()).optional(),
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
  return c.body(SANDBOX_PROXY_HTML_WITH_RECORDER);
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

      // Mirror the local CLI route's behavior: only inject the
      // OpenAI Apps SDK shim when the caller has opted in. Hosted
      // chatboxes resolve this from the active host config's
      // `mcpProfile.apps.compatRuntime` (preset fallback applied),
      // so SEP-1865-native hosts get clean HTML by default.
      const shouldInjectOpenAiCompat = body.injectOpenAiCompat === true;
      if (shouldInjectOpenAiCompat) {
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
          capabilities: body.openAiCompatCapabilities as
            | Parameters<typeof injectOpenAICompat>[1]["capabilities"]
            | undefined,
        });
      }

      return {
        html,
        csp: effectiveCspMode === "permissive" ? undefined : cspFromMeta,
        permissions: uiMeta?.permissions,
        permissive: effectiveCspMode === "permissive",
        cspMode: effectiveCspMode,
        prefersBorder: prefersBorderFromMeta,
        injectedOpenAiCompat: shouldInjectOpenAiCompat,
        injectedOpenAiCompatCapabilities:
          shouldInjectOpenAiCompat &&
          body.openAiCompatCapabilities !== undefined
            ? body.openAiCompatCapabilities
            : undefined,
        mimeType: contentMimeType,
        mimeTypeValid,
        mimeTypeWarning,
      };
    },
  ),
);

// ── File stubs (not supported in hosted mode) ────────────────────────
// The client short-circuits hosted-mode uploads/downloads before hitting
// the server (see client widget-file-messages.ts), so these are
// belt-and-suspenders.

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

export default apps;
