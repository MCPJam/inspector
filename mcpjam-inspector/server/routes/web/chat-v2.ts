import { Hono } from "hono";
import { convertToModelMessages, type ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ChatV2Request } from "@/shared/chat-v2";
import { isMCPAuthError } from "@mcpjam/sdk";
import { handleMCPJamFreeChatModel } from "../../utils/mcpjam-stream-handler.js";
import {
  handleHostedOrgChatModel,
  handleLocalOrgChatModel,
} from "../../utils/org-model-stream-handler.js";
import {
  deriveOrgProviderKey as deriveOrgProviderKeyResult,
  isLocalRuntimeEligible,
  resolveOrgProviderRuntime,
  type OrgProviderRuntime,
} from "../../utils/org-model-config.js";
import { isMCPJamProvidedModel } from "@/shared/types";
import type { ModelDefinition } from "@/shared/types";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import {
  persistChatSessionToConvex,
  pickEnrichmentHeaders,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import {
  hostedChatSchema,
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
import { getClientIp } from "../../utils/client-ip.js";

function deriveOrgProviderKey(modelDefinition: ModelDefinition): string {
  const result = deriveOrgProviderKeyResult(modelDefinition);
  if (!result.ok) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, result.error);
  }
  return result.key;
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

    // ── Convex authorization path: guest and signed-in actors ─────
    const hostedBody = parseWithSchema(hostedChatSchema, rawBody);
    const legacyWorkspaceId =
      typeof (hostedBody as any).workspaceId === "string"
        ? ((hostedBody as any).workspaceId as string)
        : undefined;
    const body = rawBody as unknown as ChatV2Request & {
      projectId: string;
      selectedServerIds: string[];
      selectedServerNames?: string[];
      shareToken?: string;
      chatboxToken?: string;
      accessScope?: "project_member" | "chat_v2";
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
        "messages are required"
      );
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "model is not supported"
      );
    }

    // Membership chat (no share/chatbox token) is the default — the backend
    // authorizes via project ownership for both guest and authed users.
    // accessScope is only set when a token is in play (shared chat / chatbox)
    // since that's an orthogonal access path keyed on the token, not the actor.
    const { manager, oauthServerUrls: urls } = await createAuthorizedManager(
      c,
      bearerToken,
      hostedBody.projectId,
      selectedServerIds,
      WEB_STREAM_TIMEOUT_MS,
      hostedBody.oauthTokens,
      hostedBody.clientCapabilities,
      {
        ...(shareToken || chatboxToken ? { accessScope: "chat_v2" } : {}),
        shareToken,
        chatboxToken,
        rpcLogger: rpcCollector.rpcLogger,
        serverNames: selectedServerNames,
      }
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

      const {
        allTools,
        enhancedSystemPrompt,
        resolvedTemperature,
        scrubMessages,
      } = prepared;
      const hostedChatSessionId = body.chatSessionId;

      const modelMessages = await convertToModelMessages(messages);
      const isMCPJam =
        Boolean(modelDefinition.id) &&
        isMCPJamProvidedModel(String(modelDefinition.id));

      if (!isMCPJam) {
        if (!process.env.CONVEX_HTTP_URL) {
          throw new WebRouteError(
            500,
            ErrorCode.INTERNAL_ERROR,
            "Server missing CONVEX_HTTP_URL configuration",
          );
        }
        if (!process.env.INSPECTOR_SERVICE_TOKEN) {
          throw new WebRouteError(
            500,
            ErrorCode.INTERNAL_ERROR,
            "Server missing INSPECTOR_SERVICE_TOKEN configuration",
          );
        }
        // Hosted org BYOK: resolve runtime location first.
        // Cloud → LLM executes in Convex (/stream/org), keys never leave Convex.
        // Local → LLM executes in the inspector using the decrypted API key.
        const providerKey = deriveOrgProviderKey(modelDefinition);
        const modelId = String(modelDefinition.id);
        const scrubbedMessages = scrubMessages(modelMessages as ModelMessage[]);
        const sourceType = shareToken
          ? "serverShare"
          : chatboxToken
          ? "chatbox"
          : "direct";

        // Cloud-only providers (everything that isn't on the local-runtime
        // allowlist) skip the /stream/org/resolve round-trip entirely. The
        // answer is always "cloud" for those, so calling resolve would just
        // add latency and a new failure point on the cloud path — which
        // regressed BYOK chat for cloud-only providers like OpenAI/Anthropic
        // when resolve was made unconditional.
        const runtime: OrgProviderRuntime = isLocalRuntimeEligible(providerKey)
          ? await resolveOrgProviderRuntime(
              hostedBody.projectId,
              providerKey,
              modelId,
              {
                authHeader: c.req.header("authorization"),
                shareToken,
                chatboxToken,
                serverIds: selectedServerIds,
              },
            )
          : { runtimeLocation: "cloud", providerKey };

        const onConversationComplete = hostedChatSessionId
          ? async (fullHistory: ModelMessage[], turnTrace: PersistedTurnTrace) => {
              const isDirectChat = !shareToken && !chatboxToken;
              await persistChatSessionToConvex({
                chatSessionId: hostedChatSessionId,
                modelId,
                modelSource:
                  runtime.runtimeLocation === "local" ? "local_byok" : "byok",
                projectId: hostedBody.projectId,
                sourceType,
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
          : undefined;

        if (runtime.runtimeLocation === "local") {
          return handleLocalOrgChatModel({
            provider: runtime.provider,
            projectId: hostedBody.projectId,
            workspaceId: legacyWorkspaceId,
            modelId,
            chatSessionId: hostedChatSessionId,
            sourceType,
            messages: scrubbedMessages,
            systemPrompt: enhancedSystemPrompt,
            temperature: resolvedTemperature,
            tools: allTools as ToolSet,
            authHeader: c.req.header("authorization"),
            shareToken,
            chatboxToken,
            selectedServers: selectedServerIds,
            requireToolApproval,
            onConversationComplete,
            onStreamComplete: () => manager.disconnectAllServers(),
            onStreamWriterReady: (writer) =>
              rpcCollector?.attachStreamWriter(writer),
          });
        }

        return handleHostedOrgChatModel({
          projectId: hostedBody.projectId,
          workspaceId: legacyWorkspaceId,
          providerKey: runtime.providerKey,
          modelId,
          chatSessionId: hostedChatSessionId,
          sourceType,
          messages: scrubbedMessages,
          systemPrompt: enhancedSystemPrompt,
          temperature: resolvedTemperature,
          tools: allTools as ToolSet,
          authHeader: c.req.header("authorization"),
          clientIp: getClientIp(c),
          shareToken,
          chatboxToken,
          mcpClientManager: manager,
          selectedServers: selectedServerIds,
          requireToolApproval,
          onConversationComplete,
          onStreamComplete: () => manager.disconnectAllServers(),
          onStreamWriterReady: (writer) =>
            rpcCollector?.attachStreamWriter(writer),
        });
      }

      // MCPJam-provided path also targets Convex (POST $CONVEX_HTTP_URL/stream),
      // so it needs the same env guard as the org BYOK branch.
      if (!process.env.CONVEX_HTTP_URL) {
        throw new WebRouteError(
          500,
          ErrorCode.INTERNAL_ERROR,
          "Server missing CONVEX_HTTP_URL configuration",
        );
      }

      return handleMCPJamFreeChatModel({
        messages: modelMessages as ModelMessage[],
        modelId: String(modelDefinition.id),
        chatSessionId: hostedChatSessionId,
        sourceType: shareToken
          ? "serverShare"
          : chatboxToken
          ? "chatbox"
          : "direct",
        systemPrompt: enhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        authHeader: c.req.header("authorization"),
        clientIp: getClientIp(c),
        chatboxToken,
        projectId: hostedBody.projectId,
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
                projectId: hostedBody.projectId,
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
        rpcCollector?.buildEnvelope()
      );
    }
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope()
    );
  }
});

export default chatV2;
