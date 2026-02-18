import { Hono } from "hono";
import { convertToModelMessages, type ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ChatV2Request } from "@/shared/chat-v2";
import { handleMCPJamFreeChatModel } from "../../utils/mcpjam-stream-handler.js";
import { isMCPJamProvidedModel } from "@/shared/types";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
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

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  // NOTE: This route does NOT use handleRoute() because handleMCPJamFreeChatModel
  // returns a streaming Response. Wrapping it in handleRoute → c.json() would
  // serialize the Response object as '{}' instead of forwarding the stream.
  try {
    const bearerToken = assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    const hostedBody = parseWithSchema(hostedChatSchema, rawBody);
    const body = rawBody as unknown as ChatV2Request & {
      workspaceId: string;
      selectedServerIds: string[];
    };

    const {
      messages,
      model,
      systemPrompt,
      temperature,
      requireToolApproval,
      selectedServerIds,
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

    const manager = await createAuthorizedManager(
      bearerToken,
      hostedBody.workspaceId,
      selectedServerIds,
      WEB_STREAM_TIMEOUT_MS,
      hostedBody.oauthTokens,
    );

    try {
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

      if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
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

      const modelMessages = await convertToModelMessages(messages);
      return handleMCPJamFreeChatModel({
        messages: scrubMessages(modelMessages as ModelMessage[]),
        modelId: String(modelDefinition.id),
        systemPrompt: enhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        authHeader: c.req.header("authorization"),
        mcpClientManager: manager,
        selectedServers: selectedServerIds,
        requireToolApproval,
        onStreamComplete: () => manager.disconnectAllServers(),
      });
    } catch (error) {
      await manager.disconnectAllServers();
      throw error;
    }
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
});

export default chatV2;
