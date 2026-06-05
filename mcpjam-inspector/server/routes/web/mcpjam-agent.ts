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
 *   - Rejects chatbox / appTools / selectedServerIds fields up front — this
 *     surface owns its tool set.
 */
import { Hono } from "hono";
import { z } from "zod";
import { MCPClientManager, type HttpServerConfig } from "@mcpjam/sdk";
import { isMCPAuthError } from "@mcpjam/sdk";
import {
  WEB_STREAM_TIMEOUT_MS,
} from "../../config.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { streamWebChatTurn } from "../../utils/web-chat-turn.js";
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
// further downstream by `convertToModelMessages` / model handlers. The
// agent surface explicitly does NOT accept fields that would route the
// turn through project servers or app tools — those are rejected via
// `.strict()` so a tampered body can't pivot the agent into a different
// host config.
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
  .strict();

const mcpjamAgent = new Hono();

mcpjamAgent.post("/", async (c) => {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;
  let manager: InstanceType<typeof MCPClientManager> | undefined;
  try {
    assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    rpcCollector = createHostedRpcLogCollector(rawBody);
    const body = parseWithSchema(mcpjamAgentSchema, rawBody);

    const docsUrl = process.env.MCPJAM_DOCS_MCP_URL ?? DEFAULT_DOCS_URL;
    const docsConfig: HttpServerConfig = {
      url: docsUrl,
      timeout: 30_000,
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
        },
        persist: {
          chatSessionId: body.chatSessionId,
          projectId: body.projectId,
          // Closed union; "direct" lets the agent ride existing billing/
          // ingestion paths. Per-surface client tagging lives in localStorage
          // and the surface event property.
          sourceType: "direct",
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
        },
        runtime: {
          authHeader: c.req.header("authorization"),
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
