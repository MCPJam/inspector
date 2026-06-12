import { Hono } from "hono";
import type { ChatV2Request } from "@/shared/chat-v2";
import { isMCPAuthError } from "@mcpjam/sdk";
import { resolveHostModelDefinition } from "../../utils/org-model-config.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import {
  validateAppToolEntries,
  AppToolValidationError,
  validateWidgetModelContextEntries,
  WidgetModelContextValidationError,
} from "../../utils/chat-v2-orchestration.js";
import { buildDirectHostConfig } from "../../utils/chat-ingestion.js";
import { streamWebChatTurn } from "../../utils/web-chat-turn.js";
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
  extractMcpInitializeOptions,
} from "./auth.js";
import { createHostedRpcLogCollector } from "./hosted-rpc-logs.js";
import { getClientIp } from "../../utils/client-ip.js";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config.js";
import { resolveExecutionContext } from "../../utils/host-execution-context.js";
import { resolveHostTools } from "../../utils/built-in-tools/registry.js";
import { logger } from "../../utils/logger.js";

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
    const { initializePins, mcpProtocolVersionsByServerId } =
      extractMcpInitializeOptions(rawBody);
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
      respectToolVisibility: bodyRespectToolVisibility,
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
    //
    // PR 4c of the engine consolidation: this merge is now owned by the
    // shared `resolveExecutionContext` helper alongside `mcp/chat-v2.ts`
    // (chat surface) and PR 4d's eval rewire. Single contract for
    // body × hostConfig × precedence; per-field warnings preserved via
    // `result.drift`. Pure refactor — `host-execution-context.test.ts`
    // locks the shape.
    let hostRuntimeConfig: Record<string, unknown> | null = null;
    if (isChatboxSession && chatboxId) {
      const runtime = await fetchChatboxRuntimeConfig({
        chatboxId,
        bearer: bearerToken,
      });
      if (runtime.ok) {
        hostRuntimeConfig = runtime.config as unknown as Record<
          string,
          unknown
        >;
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
    const resolvedExecution = resolveExecutionContext({
      hostConfig: hostRuntimeConfig,
      overrides: {
        systemPrompt: bodySystemPrompt,
        temperature: bodyTemperature,
        requireToolApproval: bodyRequireToolApproval,
        respectToolVisibility: bodyRespectToolVisibility,
        progressiveToolDiscovery: body.progressiveToolDiscovery,
        builtInToolIds: body.builtInToolIds,
      },
      precedence: "host-wins",
    });
    for (const entry of resolvedExecution.drift) {
      if (entry.field === "requireToolApproval") {
        logger.warn(
          "[chat-v2] client requireToolApproval differs from host; using host value",
          {
            chatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          }
        );
      } else if (entry.field === "progressiveToolDiscovery") {
        logger.warn(
          "[chat-v2] client progressiveToolDiscovery differs from host; using host value",
          {
            chatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          }
        );
      } else if (entry.field === "respectToolVisibility") {
        logger.warn(
          "[chat-v2] client respectToolVisibility differs from host; using host value",
          {
            chatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          }
        );
      }
    }
    // `modelId` stays a special case — the resolver yields the resolved
    // string, and `resolveHostModelDefinition` lifts it (catalog hit →
    // full def; miss → org provider config lookup, then id-shape
    // inference). The provider must come from the host id + org config,
    // never the body model: org-only ids (Bedrock, custom:NAME, OpenRouter
    // selections with vendor-prefixed ids) would otherwise inherit the
    // body's provider and route to the wrong runtime.
    if (
      isChatboxSession &&
      hostRuntimeConfig &&
      resolvedExecution.modelId &&
      resolvedExecution.modelId !== modelDefinition.id
    ) {
      const hostModelId = resolvedExecution.modelId;
      const hostModel = await resolveHostModelDefinition({
        modelId: hostModelId,
        projectId: hostedBody.projectId ?? null,
        auth: { bearerToken, chatboxId },
      });
      logger.warn("[chat-v2] client model differs from host; using host model", {
        chatboxId,
        body: modelDefinition.id,
        host: hostModelId,
        provider: hostModel.provider,
      });
      modelDefinition = hostModel;
    }
    const systemPrompt = resolvedExecution.systemPrompt;
    const temperature = resolvedExecution.temperature;
    const requireToolApproval = resolvedExecution.requireToolApproval;
    const respectToolVisibility = resolvedExecution.respectToolVisibility;
    const resolvedProgressiveToolDiscovery =
      resolvedExecution.progressiveToolDiscovery;
    // Host-config tools (web_search, bash, …) — one resolver owns which
    // config field produces which tool and with which gates (see
    // built-in-tools/registry.ts). `computer` comes exclusively from the
    // server-resolved runtime config — never the request body — so a
    // tampered client can't attach a shell the host didn't authorize; the
    // resolver also skips computer-backed tools for guest actors.
    const builtInTools = resolveHostTools(
      {
        builtInToolIds: resolvedExecution.builtInToolIds,
        computer:
          isChatboxSession && hostRuntimeConfig
            ? (hostRuntimeConfig as { computer?: unknown }).computer
            : undefined,
      },
      {
        authHeader: bearerToken,
        projectId: hostedBody.projectId,
        ...(body.chatSessionId ? { chatSessionId: body.chatSessionId } : {}),
        isGuest: Boolean(c.get("guestId")),
        requireToolApproval,
      }
    );

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
        initializePins,
        mcpProtocolVersionsByServerId,
      }
    );
    oauthServerUrls = urls;

    // SEP-1865 App-Provided Tools: validate the client snapshot at the
    // boundary. Oversize / malformed entries 400 with a clean message
    // before prepareChatV2 ever sees them.
    let validatedAppTools;
    try {
      validatedAppTools = validateAppToolEntries(body.appTools);
    } catch (error) {
      if (error instanceof AppToolValidationError) {
        throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      throw error;
    }

    let validatedWidgetModelContext;
    try {
      validatedWidgetModelContext = validateWidgetModelContextEntries(
        body.widgetModelContext
      );
    } catch (error) {
      if (error instanceof WidgetModelContextValidationError) {
        throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      throw error;
    }

    try {
      const sourceType = isChatboxSession ? "chatbox" : "direct";
      // Mirrors the sourceType branch — chatbox surface stays "chatbox", the
      // non-chatbox case is the inspector playground. The docs agent has its
      // own route (mcpjam-agent.ts) and never lands here.
      const origin = isChatboxSession ? "chatbox" : "playground";
      const isDirectChat = !isChatboxSession;

      return await streamWebChatTurn({
        manager,
        prepare: {
          selectedServerIds,
          modelDefinition,
          systemPrompt,
          temperature,
          requireToolApproval,
          respectToolVisibility,
          customProviders: body.customProviders,
          uiMessages: messages,
          ...(resolvedProgressiveToolDiscovery !== undefined
            ? {
                progressiveToolDiscovery: {
                  enabled: resolvedProgressiveToolDiscovery,
                },
              }
            : {}),
          appTools: validatedAppTools,
          widgetModelContext: validatedWidgetModelContext,
          ...(builtInTools ? { builtInTools } : {}),
        },
        persist: {
          chatSessionId: body.chatSessionId,
          projectId: hostedBody.projectId,
          sourceType,
          origin,
          ...(isChatboxSession && surface ? { surface } : {}),
          chatboxId,
          accessVersion,
          authenticatedUserId,
          originalMessages: messages,
          ...(isDirectChat ? { directVisibility: body.directVisibility } : {}),
          // Closure receives `resolvedTemperature` from inside the helper,
          // preserving the legacy behavior where chat-v2 fed the post-
          // prepare resolved temperature into `buildDirectHostConfig`.
          hostConfig: isDirectChat
            ? ({ resolvedTemperature }) =>
                buildDirectHostConfig({
                  modelId: String(modelDefinition.id),
                  // Phase 3: real host style flows from the chat tab; old
                  // inspector builds omit it and the backend defaults to
                  // 'claude' (no more legacy 'direct' hostStyle in new traces).
                  hostStyle: body.hostStyle,
                  systemPrompt,
                  requestedTemperature: temperature,
                  resolvedTemperature,
                  requireToolApproval,
                  respectToolVisibility,
                  selectedServerIds,
                })
            : null,
          selectedServerNames,
          selectedServerIds,
          systemPrompt,
          temperature,
          requireToolApproval,
          respectToolVisibility,
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
