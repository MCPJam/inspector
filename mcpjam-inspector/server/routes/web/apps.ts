import { Hono } from "hono";
import { z } from "zod";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  buildSandboxProxyFrameAncestors,
  renderSandboxProxyHtml,
} from "../apps/mcp-apps/sandbox-proxy-html.js";
import { injectOpenAICompat } from "../../utils/widget-helpers.js";
import { logger } from "../../utils/logger.js";
import {
  canSkipListingLookup,
  findListingMetaForUri,
  resolveUiResourceMeta,
} from "../../utils/ui-resource-meta.js";
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
  // Same list the proxy pins its host origin against — see
  // sandbox-proxy-html.ts for why these two must not drift.
  c.header("Content-Security-Policy", buildSandboxProxyFrameAncestors());
  c.res.headers.delete("X-Frame-Options");
  return c.body(renderSandboxProxyHtml());
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

      // SEP-1865 effective UI metadata resolution. Shared with the local
      // route via utils/ui-resource-meta.ts: per-field precedence of
      // content `_meta.ui` → listing `_meta.ui` → legacy `openai/widget*`.
      // The spec requires hosts to check BOTH the `resources/read` content
      // item and the `resources/list` entry — a server that declares
      // `_meta.ui` only at listing level used to render blank here while
      // working fine locally.
      const resourceMeta = content._meta as
        | Record<string, unknown>
        | undefined;

      // Best-effort listing lookup: servers without `resources/list` (or
      // that don't return this URI) simply fall through to the content
      // item, exactly as before this lookup existed.
      // A content item that already declares every field can't be improved
      // by a lower-precedence source, so skip the round-trip entirely.
      const listingMeta = canSkipListingLookup(resourceMeta)
        ? undefined
        : await findListingMetaForUri(
            manager,
            body.serverId,
            resolvedResourceUri,
            (reason) =>
              logger.debug("[MCP Apps] resources/list fallback skipped", {
                resourceUri: resolvedResourceUri,
                reason,
              }),
          );

      const {
        csp: cspFromMeta,
        permissions: permissionsFromMeta,
        prefersBorder: prefersBorderFromMeta,
        domain: declaredDomain,
        metadataSource,
        metadataSources,
      } = resolveUiResourceMeta({
        contentMeta: resourceMeta,
        listingMeta,
      });

      // Mirror the local CLI route's behavior: only inject the
      // OpenAI Apps SDK shim when the caller has opted in. Hosted
      // scenarios resolve this from the active host config's
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
        // Always report what the resource declared — see the matching
        // comment in routes/apps/mcp-apps/index.ts. `cspMode` decides
        // whether a CSP is injected (`permissive` below), not what the
        // resource declared.
        csp: cspFromMeta,
        permissions: permissionsFromMeta,
        permissive: effectiveCspMode === "permissive",
        cspMode: effectiveCspMode,
        prefersBorder: prefersBorderFromMeta,
        declaredDomain,
        injectedOpenAiCompat: shouldInjectOpenAiCompat,
        injectedOpenAiCompatCapabilities:
          shouldInjectOpenAiCompat &&
          body.openAiCompatCapabilities !== undefined
            ? body.openAiCompatCapabilities
            : undefined,
        mimeType: contentMimeType,
        mimeTypeValid,
        mimeTypeWarning,
        // SEP-1865 metadata precedence, mirroring the local route.
        // `metadataSource` is a summary ("mixed" when per-field fallbacks
        // used different sources); `metadataSources` reports per field.
        metadataSource,
        metadataSources,
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
