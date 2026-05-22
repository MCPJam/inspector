import { Hono } from "hono";
import { convertToModelMessages, type ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ChatV2Request } from "@/shared/chat-v2";
import { isMCPAuthError } from "@mcpjam/sdk";
import {
  handleMCPJamFreeChatModel,
  warnIfChatAbortSignalMissing,
} from "../../utils/mcpjam-stream-handler.js";
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
import { getModelById, isMCPJamProvidedModel } from "@/shared/types";
import type { ModelDefinition } from "@/shared/types";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import {
  buildDirectHostConfig,
  persistChatSessionToConvex,
  pickEnrichmentHeaders,
  stampSenderUserIdsOnSessionMessages,
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
import { createHostedRpcLogCollector } from "./hosted-rpc-logs.js";
import { getClientIp } from "../../utils/client-ip.js";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config.js";
import { logger } from "../../utils/logger.js";

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
      // Clients call /api/web/chatboxes/redeem on mount and pass the
      // resolved `chatboxId` + `accessVersion` on every chatbox-aware
      // request thereafter. The link token is never forwarded on the
      // read path.
      chatboxId?: string;
      accessVersion?: number;
      accessScope?: "project_member" | "chat_v2";
      surface?: "preview" | "share_link";
    };

    const {
      messages,
      model,
      systemPrompt: bodySystemPrompt,
      temperature: bodyTemperature,
      requireToolApproval: bodyRequireToolApproval,
      selectedServerIds,
      selectedServerNames,
      chatboxId,
      accessVersion,
      surface,
    } = body;
    // True when this turn flows through a chatbox surface. sourceType +
    // accessScope decisions hinge on this.
    const isChatboxSession = Boolean(chatboxId);

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "messages are required"
      );
    }

    let modelDefinition = model;
    if (!modelDefinition) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "model is not supported"
      );
    }

    // Host config is owned by the chatbox's host, not the request body.
    // When this turn is chatbox-bound, re-resolve the live values from
    // Convex so a stale client snapshot or tampered body can't route the
    // session through a different model or skip tool approval. The
    // helper is a no-op (returns body values) for non-chatbox surfaces.
    let resolvedSystemPrompt = bodySystemPrompt;
    let resolvedTemperatureOverride = bodyTemperature;
    let resolvedRequireToolApproval = bodyRequireToolApproval;
    if (isChatboxSession && chatboxId) {
      const runtime = await fetchChatboxRuntimeConfig({
        chatboxId,
        bearer: bearerToken,
      });
      if (runtime.ok) {
        const cfg = runtime.config;
        if (
          bodyRequireToolApproval !== undefined &&
          cfg.requireToolApproval !== bodyRequireToolApproval
        ) {
          logger.warn(
            "[chat-v2] client requireToolApproval differs from host; using host value",
            {
              chatboxId,
              body: bodyRequireToolApproval,
              host: cfg.requireToolApproval,
            }
          );
        }
        // Model is part of the host-owned contract: a tampered body
        // mustn't be able to route a chatbox session through a different
        // model than the host's hostConfigs row specifies. When the
        // host's modelId is in our built-in catalog we substitute the
        // full ModelDefinition (correct provider routing); otherwise
        // (custom provider unknown to backend) we swap just the id and
        // keep the body's provider fields, then warn.
        if (cfg.modelId && cfg.modelId !== modelDefinition.id) {
          const hostModel = getModelById(cfg.modelId);
          if (hostModel) {
            logger.warn(
              "[chat-v2] client model differs from host; using host model",
              { chatboxId, body: modelDefinition.id, host: cfg.modelId }
            );
            modelDefinition = hostModel;
          } else {
            logger.warn(
              "[chat-v2] host model not in catalog; swapping id only",
              { chatboxId, body: modelDefinition.id, host: cfg.modelId }
            );
            modelDefinition = { ...modelDefinition, id: cfg.modelId };
          }
        }
        resolvedSystemPrompt = cfg.systemPrompt;
        resolvedTemperatureOverride = cfg.temperature;
        resolvedRequireToolApproval = cfg.requireToolApproval;
      } else {
        // Don't fail the chat send on a transient Convex blip — fall
        // through to client-supplied values and warn. The chat will run
        // with potentially stale config, which is the current behavior;
        // the host-side override is best-effort hardening, not a
        // hard gate.
        logger.warn(
          "[chat-v2] runtime-config fetch failed; using body values",
          {
            chatboxId,
            status: runtime.status,
            error: runtime.error,
          }
        );
      }
    }
    const systemPrompt = resolvedSystemPrompt;
    const temperature = resolvedTemperatureOverride;
    const requireToolApproval = resolvedRequireToolApproval;

    // Membership chat (no share/chatbox token) is the default — the backend
    // authorizes via project ownership for both guest and authed users.
    // accessScope is only set when a token is in play (shared chat / chatbox)
    // since that's an orthogonal access path keyed on the token, not the actor.
    const {
      manager,
      oauthServerUrls: urls,
      authenticatedUserId,
    } = await createAuthorizedManager(
      c,
      bearerToken,
      hostedBody.projectId,
      selectedServerIds,
      WEB_STREAM_TIMEOUT_MS,
      hostedBody.oauthTokens,
      hostedBody.clientCapabilities,
      {
        ...(isChatboxSession ? { accessScope: "chat_v2" } : {}),
        chatboxId,
        accessVersion,
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
        progressivePlan,
        discoveryState,
      } = prepared;
      const hostedChatSessionId = body.chatSessionId;

      const modelMessages = await convertToModelMessages(messages);
      const cleanupStream = async () => {
        await manager.disconnectAllServers();
      };
      const isMCPJam =
        Boolean(modelDefinition.id) &&
        isMCPJamProvidedModel(String(modelDefinition.id));

      if (!isMCPJam) {
        if (!process.env.CONVEX_HTTP_URL) {
          throw new WebRouteError(
            500,
            ErrorCode.INTERNAL_ERROR,
            "Server missing CONVEX_HTTP_URL configuration"
          );
        }
        // Hosted org BYOK: resolve runtime location first.
        // Cloud → LLM executes in Convex (/stream/org), keys never leave Convex.
        // Local → LLM executes in the inspector using the decrypted API key.
        const providerKey = deriveOrgProviderKey(modelDefinition);
        const modelId = String(modelDefinition.id);
        const scrubbedMessages = scrubMessages(modelMessages as ModelMessage[]);
        const sourceType = isChatboxSession ? "chatbox" : "direct";

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
                chatboxId,
                accessVersion,
                serverIds: selectedServerIds,
              }
            )
          : { runtimeLocation: "cloud", providerKey };

        const onConversationComplete = hostedChatSessionId
          ? async (
              fullHistory: ModelMessage[],
              turnTrace: PersistedTurnTrace
            ) => {
              const isDirectChat = !isChatboxSession;
              await persistChatSessionToConvex({
                chatSessionId: hostedChatSessionId,
                modelId,
                modelSource:
                  runtime.runtimeLocation === "local" ? "local_byok" : "byok",
                projectId: hostedBody.projectId,
                sourceType,
                ...(isChatboxSession && surface ? { surface } : {}),
                chatboxId,
                accessVersion,
                authHeader: c.req.header("authorization"),
                sessionMessages: stampSenderUserIdsOnSessionMessages(
                  fullHistory,
                  messages,
                  { authenticatedUserId }
                ),
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
                      hostConfig: buildDirectHostConfig({
                        modelId,
                        // Phase 3: real host style flows from the
                        // chat tab; old inspector builds omit it and
                        // the backend defaults to 'claude' (no more
                        // legacy 'direct' hostStyle in new traces).
                        hostStyle: body.hostStyle,
                        systemPrompt,
                        requestedTemperature: temperature,
                        resolvedTemperature,
                        requireToolApproval,
                        selectedServerIds,
                      }),
                    }
                  : {}),
                turnTrace,
                forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
              });
            }
          : undefined;

        const inboundAbortSignal = c.req.raw.signal as AbortSignal | undefined;
        warnIfChatAbortSignalMissing(inboundAbortSignal, "web/chat-v2");

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
            progressivePlan,
            discoveryState,
            authHeader: c.req.header("authorization"),
            chatboxId,
            accessVersion,
            selectedServers: selectedServerIds,
            serverIds: selectedServerIds,
            requireToolApproval,
            onConversationComplete,
            onStreamComplete: cleanupStream,
            onStreamWriterReady: (writer) =>
              rpcCollector?.attachStreamWriter(writer),
            abortSignal: inboundAbortSignal,
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
          progressivePlan,
          discoveryState,
          authHeader: c.req.header("authorization"),
          clientIp: getClientIp(c),
          chatboxId,
          accessVersion,
          mcpClientManager: manager,
          selectedServers: selectedServerIds,
          serverIds: selectedServerIds,
          requireToolApproval,
          onConversationComplete,
          onStreamComplete: cleanupStream,
          onStreamWriterReady: (writer) =>
            rpcCollector?.attachStreamWriter(writer),
          abortSignal: inboundAbortSignal,
        });
      }

      // MCPJam-provided path also targets Convex (POST $CONVEX_HTTP_URL/stream),
      // so it needs the same env guard as the org BYOK branch.
      if (!process.env.CONVEX_HTTP_URL) {
        throw new WebRouteError(
          500,
          ErrorCode.INTERNAL_ERROR,
          "Server missing CONVEX_HTTP_URL configuration"
        );
      }

      const inboundAbortSignalFree = c.req.raw.signal as
        | AbortSignal
        | undefined;
      warnIfChatAbortSignalMissing(inboundAbortSignalFree, "web/chat-v2");

      return handleMCPJamFreeChatModel({
        messages: modelMessages as ModelMessage[],
        modelId: String(modelDefinition.id),
        chatSessionId: hostedChatSessionId,
        sourceType: isChatboxSession ? "chatbox" : "direct",
        systemPrompt: enhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        progressivePlan,
        discoveryState,
        authHeader: c.req.header("authorization"),
        clientIp: getClientIp(c),
        chatboxId,
        accessVersion,
        projectId: hostedBody.projectId,
        mcpClientManager: manager,
        selectedServers: selectedServerIds,
        requireToolApproval,
        abortSignal: inboundAbortSignalFree,
        onConversationComplete: hostedChatSessionId
          ? async (fullHistory, turnTrace) => {
              const isDirectChat = !isChatboxSession;
              await persistChatSessionToConvex({
                chatSessionId: hostedChatSessionId,
                modelId: String(modelDefinition.id),
                modelSource: "mcpjam",
                projectId: hostedBody.projectId,
                sourceType: isChatboxSession ? "chatbox" : "direct",
                ...(isChatboxSession && surface ? { surface } : {}),
                chatboxId,
                accessVersion,
                authHeader: c.req.header("authorization"),
                sessionMessages: stampSenderUserIdsOnSessionMessages(
                  fullHistory,
                  messages,
                  { authenticatedUserId }
                ),
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
                      hostConfig: buildDirectHostConfig({
                        modelId: String(modelDefinition.id),
                        // Phase 3: forward the chat tab's resolved
                        // host style (parity with the org-BYOK and
                        // mcp/chat-v2 call sites). Without this, the
                        // MCPJam-free path always persisted as
                        // 'claude' regardless of the user's actual
                        // hostStyle.
                        hostStyle: body.hostStyle,
                        systemPrompt,
                        requestedTemperature: temperature,
                        resolvedTemperature,
                        requireToolApproval,
                        selectedServerIds,
                      }),
                    }
                  : {}),
                turnTrace,
                forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
              });
            }
          : undefined,
        onStreamComplete: cleanupStream,
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

export default chatV2;
