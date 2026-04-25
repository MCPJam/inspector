import { Hono } from "hono";
import { convertToModelMessages, type ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ChatV2Request } from "@/shared/chat-v2";
import { isMCPAuthError, MCPClientManager } from "@mcpjam/sdk";
import type { HttpServerConfig } from "@mcpjam/sdk";
import { handleMCPJamFreeChatModel } from "../../utils/mcpjam-stream-handler.js";
import { handleHostedOrgChatModel } from "../../utils/org-model-stream-handler.js";
import {
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "@/shared/types";
import type { ModelDefinition } from "@/shared/types";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import { validateUrl, OAuthProxyError } from "../../utils/oauth-proxy.js";
import {
  persistChatSessionToConvex,
  pickEnrichmentHeaders,
} from "../../utils/chat-ingestion.js";
import {
  hostedChatSchema,
  guestServerInputSchema,
  createAuthorizedManager,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  ErrorCode,
  WebRouteError,
  webError,
  mapRuntimeError,
} from "./auth.js";
import {
  attachHostedRpcLogs,
  createHostedRpcLogCollector,
} from "./hosted-rpc-logs.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";

/**
 * Map a ModelDefinition to the providerKey used by the org-managed model
 * provider config (matches convex/organizationModelProviders.ts). Custom
 * providers prefix with "custom:<displayName>" because that's how the
 * inspector's org admin UI registers them.
 */
function deriveOrgProviderKey(modelDefinition: ModelDefinition): string {
  if (modelDefinition.provider === "custom") {
    if (!modelDefinition.customProviderName) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Custom model is missing customProviderName",
      );
    }
    return `custom:${modelDefinition.customProviderName}`;
  }
  return modelDefinition.provider;
}

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  // NOTE: This route does NOT use handleRoute() because handleMCPJamFreeChatModel
  // returns a streaming Response. Wrapping it in handleRoute → c.json() would
  // serialize the Response object as '{}' instead of forwarding the stream.
  // Track OAuth server URLs so we can enrich auth errors with redirect info
  let oauthServerUrls: Record<string, string> = {};
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;
  try {
    const bearerToken = assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    rpcCollector = createHostedRpcLogCollector(rawBody);

    // Detect guest request by body shape: no workspaceId means guest-direct
    // (matching the pattern from withEphemeralConnection in auth.ts)
    const isGuestRequest = !rawBody.workspaceId;

    if (isGuestRequest) {
      // ── Guest path: direct connection, no Convex authorization ──
      const guestId = c.get("guestId") as string | undefined;
      if (!guestId) {
        throw new WebRouteError(
          401,
          ErrorCode.UNAUTHORIZED,
          "Valid guest token required. Please refresh the page to obtain a new session.",
        );
      }

      const body = rawBody as unknown as ChatV2Request & {
        serverName?: string;
        serverUrl?: string;
        serverHeaders?: Record<string, string>;
        oauthAccessToken?: string;
      };

      const {
        messages,
        model,
        systemPrompt,
        temperature,
        requireToolApproval,
      } = body;

      if (!Array.isArray(messages) || messages.length === 0) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "messages are required",
        );
      }

      const modelDefinition = model;
      if (!modelDefinition) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "model is not supported",
        );
      }

      if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
        if (!isMCPJamGuestAllowedModel(modelDefinition.id)) {
          throw new WebRouteError(
            403,
            ErrorCode.FORBIDDEN,
            "This MCPJam model is not available for guest access. Sign in to continue.",
          );
        }
        if (!process.env.CONVEX_HTTP_URL) {
          throw new WebRouteError(
            500,
            ErrorCode.INTERNAL_ERROR,
            "Server missing CONVEX_HTTP_URL configuration",
          );
        }
      } else {
        throw new WebRouteError(
          400,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "Only MCPJam hosted models are supported in hosted mode",
        );
      }

      // Build the MCPClientManager: either with a guest server or empty
      let manager: InstanceType<typeof MCPClientManager>;
      const hasServer = typeof body.serverUrl === "string" && body.serverUrl;

      if (hasServer) {
        // Guest with MCP server — validate and connect
        const guestInput = parseWithSchema(guestServerInputSchema, rawBody);

        try {
          await validateUrl(guestInput.serverUrl, true);
        } catch (err) {
          if (err instanceof OAuthProxyError) {
            throw new WebRouteError(
              err.status,
              ErrorCode.VALIDATION_ERROR,
              err.message,
            );
          }
          throw err;
        }

        const headers: Record<string, string> = {
          ...(guestInput.serverHeaders ?? {}),
        };

        if (typeof body.oauthAccessToken === "string") {
          headers["Authorization"] = `Bearer ${body.oauthAccessToken}`;
        }

        const httpConfig: HttpServerConfig = {
          url: guestInput.serverUrl,
          requestInit: { headers },
          timeout: WEB_STREAM_TIMEOUT_MS,
        };

        manager = new MCPClientManager(
          { __guest__: httpConfig },
          {
            defaultTimeout: WEB_STREAM_TIMEOUT_MS,
            rpcLogger: rpcCollector.rpcLogger,
            retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
          },
        );
      } else {
        // Guest without servers — empty manager for plain LLM chat
        manager = new MCPClientManager(
          {},
          {
            defaultTimeout: WEB_STREAM_TIMEOUT_MS,
            rpcLogger: rpcCollector.rpcLogger,
            retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
          },
        );
      }

      try {
        const sessionStartedAt = Date.now();
        const selectedServers = hasServer ? ["__guest__"] : [];

        let prepared;
        try {
          prepared = await prepareChatV2({
            mcpClientManager: manager,
            selectedServers,
            modelDefinition,
            systemPrompt,
            temperature,
            requireToolApproval,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes("Invalid tool name(s) for Anthropic")) {
            throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, msg);
          }
          throw error;
        }

        const {
          allTools,
          enhancedSystemPrompt,
          resolvedTemperature,
          scrubMessages,
        } = prepared;

        const modelMessages = await convertToModelMessages(messages);
        const directChatSessionId = body.chatSessionId;
        return handleMCPJamFreeChatModel({
          messages: scrubMessages(modelMessages as ModelMessage[]),
          modelId: String(modelDefinition.id),
          systemPrompt: enhancedSystemPrompt,
          temperature: resolvedTemperature,
          tools: allTools as ToolSet,
          authHeader: c.req.header("authorization"),
          mcpClientManager: manager,
          selectedServers,
          requireToolApproval,
          onConversationComplete: directChatSessionId
            ? async (fullHistory, turnTrace) => {
                await persistChatSessionToConvex({
                  chatSessionId: directChatSessionId,
                  modelId: String(modelDefinition.id),
                  modelSource: "mcpjam",
                  sourceType: "direct",
                  directVisibility: body.directVisibility,
                  authHeader: c.req.header("authorization"),
                  sessionMessages: fullHistory,
                  startedAt: sessionStartedAt,
                  lastActivityAt: Date.now(),
                  resumeConfig: {
                    systemPrompt,
                    temperature,
                    requireToolApproval,
                    selectedServers: hasServer ? ["__guest__"] : [],
                  },
                  turnTrace,
                  forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
                });
              }
            : undefined,
          onStreamComplete: () => manager.disconnectAllServers(),
          onStreamWriterReady: (writer) =>
            rpcCollector?.attachStreamWriter(writer),
        });
      } catch (error) {
        await manager.disconnectAllServers();
        throw error;
      }
    }

    // ── Authenticated path: Convex authorization ──────────────────
    const hostedBody = parseWithSchema(hostedChatSchema, rawBody);
    const body = rawBody as unknown as ChatV2Request & {
      workspaceId: string;
      selectedServerIds: string[];
      selectedServerNames?: string[];
      shareToken?: string;
      chatboxToken?: string;
      accessScope?: "workspace_member" | "chat_v2";
      surface?: "preview" | "share_link";
    };

    const {
      messages,
      model,
      systemPrompt,
      temperature,
      requireToolApproval,
      selectedServerIds,
      selectedServerNames,
      shareToken,
      chatboxToken,
      surface,
    } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "messages are required",
      );
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "model is not supported",
      );
    }

    const { manager, oauthServerUrls: urls } = await createAuthorizedManager(
      bearerToken,
      hostedBody.workspaceId,
      selectedServerIds,
      WEB_STREAM_TIMEOUT_MS,
      hostedBody.oauthTokens,
      hostedBody.clientCapabilities,
      {
        accessScope: "chat_v2",
        shareToken,
        chatboxToken,
        rpcLogger: rpcCollector.rpcLogger,
        serverNames: selectedServerNames,
      },
    );
    oauthServerUrls = urls;

    try {
      const sessionStartedAt = Date.now();
      let prepared;
      try {
        prepared = await prepareChatV2({
          mcpClientManager: manager,
          selectedServers: selectedServerIds,
          modelDefinition,
          systemPrompt,
          temperature,
          requireToolApproval,
          customProviders: body.customProviders,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Invalid tool name(s) for Anthropic")) {
          throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, msg);
        }
        throw error;
      }

      const { allTools, enhancedSystemPrompt, resolvedTemperature } = prepared;
      const hostedChatSessionId = body.chatSessionId;

      if (!process.env.CONVEX_HTTP_URL) {
        throw new WebRouteError(
          500,
          ErrorCode.INTERNAL_ERROR,
          "Server missing CONVEX_HTTP_URL configuration",
        );
      }

      const modelMessages = await convertToModelMessages(messages);
      const isMCPJam =
        Boolean(modelDefinition.id) &&
        isMCPJamProvidedModel(String(modelDefinition.id));

      if (!isMCPJam) {
        // Hosted org BYOK: vault-resolved provider keys live in Convex; the
        // inspector forwards messages and tool definitions to /stream/org and
        // drives the agentic loop locally.
        const providerKey = deriveOrgProviderKey(modelDefinition);
        return handleHostedOrgChatModel({
          workspaceId: hostedBody.workspaceId,
          providerKey,
          modelId: String(modelDefinition.id),
          messages: modelMessages as ModelMessage[],
          systemPrompt: enhancedSystemPrompt,
          temperature: resolvedTemperature,
          tools: allTools as ToolSet,
          mcpClientManager: manager,
          selectedServers: selectedServerIds,
          requireToolApproval,
          onConversationComplete: hostedChatSessionId
            ? async (fullHistory, turnTrace) => {
                const isDirectChat = !shareToken && !chatboxToken;
                await persistChatSessionToConvex({
                  chatSessionId: hostedChatSessionId,
                  modelId: String(modelDefinition.id),
                  modelSource: "byok",
                  workspaceId: hostedBody.workspaceId,
                  sourceType: shareToken
                    ? "serverShare"
                    : chatboxToken
                      ? "chatbox"
                      : "direct",
                  ...(chatboxToken && surface ? { surface } : {}),
                  shareToken,
                  chatboxToken,
                  ...(shareToken && selectedServerIds[0]
                    ? { serverId: selectedServerIds[0] }
                    : {}),
                  authHeader: c.req.header("authorization"),
                  sessionMessages: fullHistory,
                  startedAt: sessionStartedAt,
                  lastActivityAt: Date.now(),
                  ...(isDirectChat
                    ? {
                        directVisibility: body.directVisibility,
                        resumeConfig: {
                          systemPrompt,
                          temperature,
                          requireToolApproval,
                          selectedServers:
                            Array.isArray(selectedServerNames) &&
                            selectedServerNames.length ===
                              selectedServerIds.length
                              ? selectedServerNames
                              : selectedServerIds,
                        },
                      }
                    : {}),
                  turnTrace,
                  forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
                });
              }
            : undefined,
          onStreamComplete: () => manager.disconnectAllServers(),
          onStreamWriterReady: (writer) =>
            rpcCollector?.attachStreamWriter(writer),
        });
      }

      return handleMCPJamFreeChatModel({
        messages: modelMessages as ModelMessage[],
        modelId: String(modelDefinition.id),
        systemPrompt: enhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        authHeader: c.req.header("authorization"),
        chatboxToken,
        workspaceId: hostedBody.workspaceId,
        mcpClientManager: manager,
        selectedServers: selectedServerIds,
        requireToolApproval,
        onConversationComplete: hostedChatSessionId
          ? async (fullHistory, turnTrace) => {
              const isDirectChat = !shareToken && !chatboxToken;
              await persistChatSessionToConvex({
                chatSessionId: hostedChatSessionId,
                modelId: String(modelDefinition.id),
                modelSource: "mcpjam",
                workspaceId: hostedBody.workspaceId,
                sourceType: shareToken
                  ? "serverShare"
                  : chatboxToken
                    ? "chatbox"
                    : "direct",
                ...(chatboxToken && surface ? { surface } : {}),
                shareToken,
                chatboxToken,
                ...(shareToken && selectedServerIds[0]
                  ? { serverId: selectedServerIds[0] }
                  : {}),
                authHeader: c.req.header("authorization"),
                sessionMessages: fullHistory,
                startedAt: sessionStartedAt,
                lastActivityAt: Date.now(),
                ...(isDirectChat
                  ? {
                      directVisibility: body.directVisibility,
                      resumeConfig: {
                        systemPrompt,
                        temperature,
                        requireToolApproval,
                        selectedServers:
                          Array.isArray(selectedServerNames) &&
                          selectedServerNames.length === selectedServerIds.length
                            ? selectedServerNames
                            : selectedServerIds,
                      },
                    }
                  : {}),
                turnTrace,
                forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
              });
            }
          : undefined,
        onStreamComplete: () => manager.disconnectAllServers(),
        onStreamWriterReady: (writer) =>
          rpcCollector?.attachStreamWriter(writer),
      });
    } catch (error) {
      await manager.disconnectAllServers();
      throw error;
    }
  } catch (error) {
    // Enrich MCPAuthError with OAuth server URL so the client can initiate OAuth
    if (isMCPAuthError(error) && Object.keys(oauthServerUrls).length > 0) {
      const firstUrl = Object.values(oauthServerUrls)[0];
      const msg = error instanceof Error ? error.message : String(error);
      return webError(
        c,
        401,
        ErrorCode.UNAUTHORIZED,
        msg,
        {
          oauthRequired: true,
          serverUrl: firstUrl,
        },
        rpcCollector?.buildEnvelope(),
      );
    }
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope(),
    );
  }
});

export default chatV2;
