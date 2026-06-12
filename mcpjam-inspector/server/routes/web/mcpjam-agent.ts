/**
 * MCPJam Agent — POST /api/web/mcpjam-agent
 *
 * Chat surface connected to two MCPJam-owned MCP servers:
 *   - the hosted docs server (`https://docs.mcpjam.com/mcp`, Mintlify) for
 *     documentation search, and
 *   - the MCPJam platform MCP worker (`https://mcp.mcpjam.com/mcp`,
 *     Cloudflare — `mcp/` in this monorepo) for the workspace catalog
 *     (projects, servers, evals, chatboxes) INCLUDING its MCP Apps widget
 *     tools (`show_servers` & co). The platform server is the single owner
 *     of those tools; the agent is a plain MCP client of it, so widget
 *     metadata, `ui://` resources, and payload tagging all flow through the
 *     standard protocol pipeline.
 *
 * The Home page is its first consumer; the side-panel bubble across the
 * rest of the UI hits the same endpoint.
 *
 * Auth to the platform worker: the worker verifies AuthKit JWTs from the
 * same issuer the inspector authenticates with (prod `login.mcpjam.com`,
 * staging `dynamic-echo-14-staging`), so the caller's bearer is forwarded
 * as the MCP `accessToken`. Local dev tokens come from the dev AuthKit app,
 * which deployed workers don't trust — run the worker locally
 * (`npm run dev:local` in `mcp/`) and set
 * `MCPJAM_PLATFORM_MCP_URL=http://localhost:8787/mcp`, or the agent
 * degrades to docs + web_search via the preflight below.
 *
 * Differences vs `/api/web/chat-v2`:
 *   - The agent owns its own `MCPClientManager` hardcoded to the two
 *     servers. It does NOT go through `createAuthorizedManager`'s
 *     project-server resolution and does NOT register either server into
 *     any user's project.
 *   - Persists as `sourceType: "direct"` with `hostConfig: null` — the
 *     synthetic `"mcpjam-docs"` / `"mcpjam-platform"` ids would fail
 *     backend `selectedServerIds` validation against the project's
 *     `servers` rows. The chat appears in the user's history alongside
 *     other direct sessions; per-surface differentiation is client-side.
 *   - Rejects chatbox / appTools / selectedServerIds fields up front — this
 *     surface owns its tool set.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  MCPClientManager,
  type HttpServerConfig,
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "@mcpjam/sdk";
import { isMCPAuthError } from "@mcpjam/sdk";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { streamWebChatTurn } from "../../utils/web-chat-turn.js";
import { WEB_SEARCH_TOOL_NAME } from "../../utils/built-in-tools/exa-web-search.js";
import { resolveHostTools } from "../../utils/built-in-tools/registry.js";
import { injectOpenAICompat } from "../../utils/widget-helpers.js";
import { logger } from "../../utils/logger.js";
import { MCPJAM_PLATFORM_SERVER_ID } from "../../../shared/mcpjam-agent-widgets";
import {
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  ErrorCode,
  webError,
  mapRuntimeError,
} from "./auth.js";
import { createHostedRpcLogCollector } from "./hosted-rpc-logs.js";
import { getClientIp } from "../../utils/client-ip.js";

const DOCS_SERVER_ID = "mcpjam-docs";
const DEFAULT_DOCS_URL = "https://docs.mcpjam.com/mcp";
const PLATFORM_SERVER_ID = MCPJAM_PLATFORM_SERVER_ID;
// Staging deployments override with https://mcp-staging.mcpjam.com/mcp;
// local dev with a local `wrangler dev` URL (see header comment).
const DEFAULT_PLATFORM_URL = "https://mcp.mcpjam.com/mcp";

// Advertise the MCP UI extension so the platform worker registers its
// widget-backed tools (the worker's session registrar swaps widget vs
// plain registrations on this capability).
const MCP_APPS_CLIENT_CAPABILITIES = {
  extensions: {
    [MCP_UI_EXTENSION_ID]: {
      mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
    },
  },
};

function buildDocsConfig(): HttpServerConfig {
  return {
    url: process.env.MCPJAM_DOCS_MCP_URL ?? DEFAULT_DOCS_URL,
    timeout: 30_000,
    clientCapabilities: MCP_APPS_CLIENT_CAPABILITIES,
  };
}

function buildPlatformConfig(bearerToken: string): HttpServerConfig {
  return {
    url: process.env.MCPJAM_PLATFORM_MCP_URL ?? DEFAULT_PLATFORM_URL,
    timeout: 30_000,
    // The caller's own AuthKit bearer — the worker verifies it against the
    // shared issuer and executes platform operations with the caller's
    // authority, exactly as if they had connected the server themselves.
    accessToken: bearerToken,
    clientCapabilities: MCP_APPS_CLIENT_CAPABILITIES,
  };
}

// Permissive schema — `messages` and `model` shapes are wide unions matched
// further downstream by `convertToModelMessages` / model handlers.
//
// `DefaultChatTransport` from `@ai-sdk/react` posts extra top-level fields
// (`id`, `trigger`, `messageId`, …) on every turn. `hostedChatSchema` in
// `auth.ts` tolerates this via `.passthrough()`; we match that pattern so
// the AI SDK extras are silently passed through instead of rejected as
// validation errors. Server-side use of the parsed body still only reads
// the explicitly-declared fields below — there's no path here that routes
// a tampered selectedServerIds / appTools / chatbox field into the
// streamWebChatTurn call because we don't read them at all.
const mcpjamAgentSchema = z
  .object({
    messages: z.array(z.any()).min(1),
    model: z
      .object({
        id: z.string().min(1),
        // Rest of the ModelDefinition fields pass through unvalidated; the
        // downstream stream handlers re-validate provider + name shape.
      })
      .passthrough(),
    chatSessionId: z.string().min(1),
    projectId: z.string().min(1),
    systemPrompt: z.string().optional(),
    temperature: z.number().optional(),
    requireToolApproval: z.boolean().optional(),
    respectToolVisibility: z.boolean().optional(),
  })
  .passthrough();

const mcpjamAgent = new Hono();

mcpjamAgent.post("/", async (c) => {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;
  let manager: InstanceType<typeof MCPClientManager> | undefined;
  try {
    const bearerToken = assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    rpcCollector = createHostedRpcLogCollector(rawBody);
    const body = parseWithSchema(mcpjamAgentSchema, rawBody);

    manager = new MCPClientManager(
      {
        [DOCS_SERVER_ID]: buildDocsConfig(),
        [PLATFORM_SERVER_ID]: buildPlatformConfig(bearerToken),
      },
      {
        defaultTimeout: WEB_STREAM_TIMEOUT_MS,
        rpcLogger: rpcCollector.rpcLogger,
        retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
      }
    );

    try {
      // Preflight the platform connection: `getToolsForAiSdk` (inside
      // `prepareChatV2`) fails the WHOLE turn when any selected server
      // errors at connect/list time, so a worker outage or an issuer
      // mismatch (local dev) would otherwise take down the entire agent —
      // docs chat included. Connect + list here and drop the platform
      // server from the selection on failure; the connection and tool
      // metadata are cached on the manager, so the later prepare doesn't
      // repeat the round trip.
      const selectedServerIds = [DOCS_SERVER_ID, PLATFORM_SERVER_ID];
      try {
        await manager.listTools(PLATFORM_SERVER_ID);
      } catch (error) {
        selectedServerIds.pop();
        logger.warn(
          "[mcpjam-agent] platform MCP server unavailable; continuing without workspace tools",
          { error: error instanceof Error ? error.message : String(error) }
        );
      }

      // Bearer is guaranteed by assertBearerToken above; thread it (plus the
      // project + session) into the web_search built-in tool, whose execute
      // proxies to the Convex Exa route for billing + the external call.
      // The agent always advertises web_search — it isn't hostConfig-gated
      // like chat-v2 / eval surfaces, so the id list is fixed here.
      // Workspace tools are NOT built-ins here: they come from the platform
      // MCP server connection above.
      const authHeader = c.req.header("authorization");
      const builtInTools = authHeader
        ? resolveHostTools(
            { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
            {
              authHeader,
              projectId: body.projectId,
              chatSessionId: body.chatSessionId,
            }
          )
        : undefined;

      return await streamWebChatTurn({
        manager,
        prepare: {
          selectedServerIds,
          modelDefinition: body.model as never,
          systemPrompt: body.systemPrompt,
          temperature: body.temperature,
          requireToolApproval: body.requireToolApproval,
          respectToolVisibility: body.respectToolVisibility,
          uiMessages: body.messages,
          builtInTools,
        },
        persist: {
          chatSessionId: body.chatSessionId,
          projectId: body.projectId,
          // Closed union; "direct" lets the agent ride existing billing/
          // ingestion paths (billing rollups + by_*_direct indexes assume
          // agent traffic is "direct"). `origin` carries the product
          // surface separately so training pipelines can filter agent
          // rows out without disturbing those readers.
          sourceType: "direct",
          origin: "mcpjam_agent",
          authenticatedUserId: undefined,
          originalMessages: body.messages,
          // No host config — the agent's server ids aren't project-validated
          // Convex ids, so `buildDirectHostConfig` would be rejected by the
          // backend `selectedServerIds` validator.
          hostConfig: null,
          selectedServerIds,
          systemPrompt: body.systemPrompt,
          temperature: body.temperature,
          requireToolApproval: body.requireToolApproval,
          respectToolVisibility: body.respectToolVisibility,
          // Synthetic server ids — the backend would discard a tool snapshot
          // whose ids aren't on the project, so skip the export fanout
          // entirely.
          captureToolSnapshot: false,
        },
        runtime: {
          authHeader,
          clientIp: getClientIp(c),
          abortSignal: c.req.raw.signal as AbortSignal | undefined,
          rpcCollector,
          c,
        },
      });
    } catch (error) {
      await manager.disconnectAllServers();
      throw error;
    }
  } catch (error) {
    if (isMCPAuthError(error)) {
      const msg = error instanceof Error ? error.message : String(error);
      return webError(
        c,
        401,
        ErrorCode.UNAUTHORIZED,
        msg,
        undefined,
        rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined
      );
    }
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined
    );
  }
});

// ── Platform widget content ──────────────────────────────────────────
//
// `POST /api/web/mcpjam-agent/widget-content` is the companion to
// `/api/web/apps/mcp-apps/widget-content` for the agent's synthetic
// servers. The general hosted endpoint resolves a Convex-registered
// project server; the agent's platform server has no Convex row, so the
// renderer can't route through `buildServerRequest`. This route does the
// same job for the platform server only: open an ephemeral authed MCP
// connection and `resources/read` the `ui://` resource — the widget HTML
// always comes from the server, per MCP Apps.
//
// The client routes here when the tool result's `_serverId` is the
// synthetic platform id (see shared/mcpjam-agent-widgets.ts and
// fetch-widget-content.ts).

const ACCEPTED_WIDGET_MIMETYPES = new Set<string>([
  RESOURCE_MIME_TYPE,
  "text/html+skybridge",
  "text/html",
]);

// Mirrors the request contract of the general widget-content route so
// `fetchMcpAppsWidgetContent` can post the identical payload to either.
const widgetContentSchema = z.object({
  resourceUri: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()).default({}),
  toolOutput: z.unknown().optional(),
  toolResponseMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
  initialWidgetState: z.unknown().optional(),
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  theme: z.enum(["light", "dark"]).optional(),
  cspMode: z.enum(["permissive", "widget-declared"]).optional(),
  injectOpenAiCompat: z.boolean().optional().default(false),
  openAiCompatCapabilities: z.record(z.string(), z.unknown()).optional(),
  template: z.string().optional(),
  viewMode: z.string().optional(),
  viewParams: z.record(z.string(), z.unknown()).optional(),
});

mcpjamAgent.post("/widget-content", async (c) => {
  let manager: InstanceType<typeof MCPClientManager> | undefined;
  try {
    const bearerToken = assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    const body = parseWithSchema(widgetContentSchema, rawBody);

    const resolvedResourceUri = body.template ?? body.resourceUri;
    if (!resolvedResourceUri.startsWith("ui://")) {
      return webError(
        c,
        400,
        ErrorCode.VALIDATION_ERROR,
        "Widget resources must use the ui:// protocol"
      );
    }

    manager = new MCPClientManager(
      { [PLATFORM_SERVER_ID]: buildPlatformConfig(bearerToken) },
      {
        defaultTimeout: WEB_STREAM_TIMEOUT_MS,
        retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
      }
    );

    try {
      const resourceResult = await manager.readResource(PLATFORM_SERVER_ID, {
        uri: resolvedResourceUri,
      });

      const contents = (resourceResult as { contents?: unknown[] })?.contents;
      const content = Array.isArray(contents) ? contents[0] : undefined;
      if (!content || typeof content !== "object") {
        return webError(c, 404, ErrorCode.NOT_FOUND, "No content in resource");
      }

      const record = content as Record<string, unknown>;
      const contentMimeType =
        typeof record.mimeType === "string" ? record.mimeType : undefined;
      const mimeTypeValid =
        contentMimeType !== undefined &&
        ACCEPTED_WIDGET_MIMETYPES.has(contentMimeType);
      const mimeTypeWarning = !mimeTypeValid
        ? contentMimeType
          ? `Invalid mimetype "${contentMimeType}" - expected one of: ${[
              ...ACCEPTED_WIDGET_MIMETYPES,
            ].join(", ")}`
          : `Missing mimetype - expected one of: ${[
              ...ACCEPTED_WIDGET_MIMETYPES,
            ].join(", ")}`
        : null;

      let html: string;
      if (typeof record.text === "string") {
        html = record.text;
      } else if (typeof record.blob === "string") {
        html = Buffer.from(record.blob, "base64").toString("utf-8");
      } else {
        return webError(
          c,
          404,
          ErrorCode.NOT_FOUND,
          "No HTML content in resource"
        );
      }

      const resourceMeta = record._meta as Record<string, unknown> | undefined;
      const uiMeta = (resourceMeta as { ui?: unknown } | undefined)?.ui as
        | {
            csp?: McpUiResourceCsp;
            permissions?: McpUiResourcePermissions;
            prefersBorder?: boolean;
          }
        | undefined;
      const effectiveCspMode = body.cspMode ?? "permissive";

      if (body.injectOpenAiCompat === true) {
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

      return c.json({
        html,
        csp: effectiveCspMode === "permissive" ? undefined : uiMeta?.csp,
        permissions: uiMeta?.permissions,
        permissive: effectiveCspMode === "permissive",
        cspMode: effectiveCspMode,
        prefersBorder: uiMeta?.prefersBorder,
        injectedOpenAiCompat: body.injectOpenAiCompat === true,
        injectedOpenAiCompatCapabilities:
          body.injectOpenAiCompat === true &&
          body.openAiCompatCapabilities !== undefined
            ? body.openAiCompatCapabilities
            : undefined,
        mimeType: contentMimeType,
        mimeTypeValid,
        mimeTypeWarning,
      });
    } finally {
      await manager.disconnectAllServers();
    }
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details
    );
  }
});

export default mcpjamAgent;
