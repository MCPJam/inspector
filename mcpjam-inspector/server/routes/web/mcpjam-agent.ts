/**
 * MCPJam Agent — POST /api/web/mcpjam-agent
 *
 * Chat surface connected to MCPJam's hosted docs MCP server
 * (`https://docs.mcpjam.com/mcp`). The Home page is its first consumer;
 * later the bubble across the rest of the UI will hit the same endpoint.
 *
 * Differences vs `/api/web/chat-v2`:
 *   - The agent owns its own `MCPClientManager` hardcoded to the docs server.
 *     It does NOT go through `createAuthorizedManager`'s project-server
 *     resolution and does NOT register the docs server into any user's
 *     project.
 *   - Persists as `sourceType: "direct"` with `hostConfig: null` — the
 *     synthetic `"mcpjam-docs"` id would fail backend `selectedServerIds`
 *     validation against the project's `servers` rows. The chat appears in
 *     the user's history alongside other direct sessions; per-surface
 *     differentiation is client-side.
 *   - Ignores chatbox / appTools / selectedServerIds fields up front — this
 *     surface owns its MCP tool set. The one client-supplied tool snapshot it
 *     DOES accept is `uiTools` (WebMCP UI tools, validated at the boundary):
 *     the agent panel is the primary surface for driving the inspector UI.
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
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { streamWebChatTurn } from "../../utils/web-chat-turn.js";
import {
  validateUiToolEntries,
  UiToolValidationError,
} from "../../utils/chat-v2-orchestration.js";
import { WEB_SEARCH_TOOL_NAME } from "../../utils/built-in-tools/exa-web-search.js";
import { resolveHostTools } from "../../utils/built-in-tools/registry.js";
import { MCPJAM_TOOL_IDS } from "../../utils/built-in-tools/mcpjam.js";
import { buildMcpjamPlatformClient } from "./mcpjam-platform-client.js";
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

// Permissive schema — `messages` and `model` shapes are wide unions matched
// further downstream by `convertToModelMessages` / model handlers.
//
// `DefaultChatTransport` from `@ai-sdk/react` posts extra top-level fields
// (`id`, `trigger`, `messageId`, …) on every turn. `hostedChatSchema` in
// `auth.ts` tolerates this via `.passthrough()`; we match that pattern so
// the AI SDK extras are silently passed through instead of rejected as
// validation errors. Server-side use of the parsed body still only reads
// the explicitly-declared fields below plus `uiTools` (validated by
// `validateUiToolEntries` before use) — there's no path here that routes
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
    // WebMCP UI tools snapshot. Wide here; `validateUiToolEntries` is the
    // real boundary (caps, `ui_` name regex, schema size) and 400s on abuse.
    uiTools: z.array(z.unknown()).optional(),
  })
  .passthrough();

const mcpjamAgent = new Hono();

mcpjamAgent.post("/", async (c) => {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;
  let manager: InstanceType<typeof MCPClientManager> | undefined;
  try {
    assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    rpcCollector = createHostedRpcLogCollector(rawBody);
    const body = parseWithSchema(mcpjamAgentSchema, rawBody);

    // WebMCP UI tools: validate the client snapshot at the boundary, same
    // treatment as web/chat-v2.
    let validatedUiTools;
    try {
      validatedUiTools = validateUiToolEntries(body.uiTools);
    } catch (error) {
      if (error instanceof UiToolValidationError) {
        return webError(c, 400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      throw error;
    }

    const docsUrl = process.env.MCPJAM_DOCS_MCP_URL ?? DEFAULT_DOCS_URL;
    const docsConfig: HttpServerConfig = {
      url: docsUrl,
      timeout: 30_000,
      clientCapabilities: {
        extensions: {
          [MCP_UI_EXTENSION_ID]: {
            mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
          },
        },
      },
    };

    manager = new MCPClientManager(
      { [DOCS_SERVER_ID]: docsConfig },
      {
        defaultTimeout: WEB_STREAM_TIMEOUT_MS,
        rpcLogger: rpcCollector.rpcLogger,
        retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
      }
    );

    try {
      // Bearer is guaranteed by assertBearerToken above; thread it (plus the
      // project + session) into the web_search built-in tool, whose execute
      // proxies to the Convex Exa route for billing + the external call.
      // The agent always advertises web_search — it isn't hostConfig-gated
      // like chat-v2 / eval surfaces, so the id list is fixed here.
      const authHeader = c.req.header("authorization");
      const builtInTools = authHeader
        ? resolveHostTools(
            { builtInToolIds: [WEB_SEARCH_TOOL_NAME, ...MCPJAM_TOOL_IDS] },
            {
              authHeader,
              projectId: body.projectId,
              chatSessionId: body.chatSessionId,
              mcpjamPlatformClient: buildMcpjamPlatformClient(c),
            }
          )
        : undefined;

      return await streamWebChatTurn({
        manager,
        prepare: {
          selectedServerIds: [DOCS_SERVER_ID],
          modelDefinition: body.model as never,
          systemPrompt: body.systemPrompt,
          temperature: body.temperature,
          requireToolApproval: body.requireToolApproval,
          respectToolVisibility: body.respectToolVisibility,
          uiMessages: body.messages,
          uiTools: validatedUiTools,
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
          // No host config — the docs server id isn't a project-validated
          // Convex id, so `buildDirectHostConfig` would be rejected by the
          // backend `selectedServerIds` validator.
          hostConfig: null,
          selectedServerIds: [DOCS_SERVER_ID],
          systemPrompt: body.systemPrompt,
          temperature: body.temperature,
          requireToolApproval: body.requireToolApproval,
          respectToolVisibility: body.respectToolVisibility,
          // `mcpjam-docs` is a synthetic server id — the backend would
          // discard a tool snapshot whose ids aren't on the project, so
          // skip the export fanout entirely.
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

export default mcpjamAgent;
