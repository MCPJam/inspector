/**
 * X-Ray Payload Endpoint (Hosted Mode)
 *
 * Returns the actual payload that would be sent to the AI model,
 * including the enhanced system prompt and all tools (MCP + skill tools).
 *
 * Hosted-mode counterpart to routes/mcp/xray-payload.ts — uses ephemeral
 * per-request connections authorised via Convex instead of the persistent
 * singleton MCPClientManager.
 */

import { Hono } from "hono";
import { z } from "zod";
import { MCPClientManager } from "@mcpjam/sdk";
import type { HttpServerConfig } from "@mcpjam/sdk";
import { buildXRayPayload } from "../../utils/xray-helpers.js";
import { validateUrl, OAuthProxyError } from "../../utils/oauth-proxy.js";
import {
  hostedChatSchema,
  guestServerInputSchema,
  createAuthorizedManager,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  handleRoute,
  withManager,
  ErrorCode,
  WebRouteError,
} from "./auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";

const xrayPayloadSchema = hostedChatSchema.extend({
  messages: z.array(z.unknown()).default([]),
  systemPrompt: z.string().optional(),
});

const xrayPayload = new Hono();

xrayPayload.post("/", async (c) => {
  return handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);

    // Detect guest requests by body shape: presence of serverUrl without workspaceId.
    const isGuestRequest =
      typeof rawBody.serverUrl === "string" && !rawBody.workspaceId;

    if (isGuestRequest) {
      // ── Guest path: direct connection, no Convex ──
      const guestId = c.get("guestId") as string | undefined;
      if (!guestId) {
        throw new WebRouteError(
          401,
          ErrorCode.UNAUTHORIZED,
          "Valid guest token required. Please refresh the page to obtain a new session.",
        );
      }

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
      if (typeof rawBody.oauthAccessToken === "string") {
        headers["Authorization"] = `Bearer ${rawBody.oauthAccessToken}`;
      }

      const httpConfig: HttpServerConfig = {
        url: guestInput.serverUrl,
        capabilities: guestInput.clientCapabilities,
        requestInit: { headers },
        timeout: WEB_CALL_TIMEOUT_MS,
      };

      const manager = new MCPClientManager(
        { __guest__: httpConfig },
        { defaultTimeout: WEB_CALL_TIMEOUT_MS },
      );

      const messages = Array.isArray(rawBody.messages) ? rawBody.messages : [];
      const systemPrompt =
        typeof rawBody.systemPrompt === "string"
          ? rawBody.systemPrompt
          : undefined;

      try {
        return await buildXRayPayload(
          manager,
          ["__guest__"],
          messages,
          systemPrompt,
        );
      } finally {
        await manager.disconnectAllServers();
      }
    }

    // ── Authenticated path: Convex authorization ──
    const body = parseWithSchema(xrayPayloadSchema, rawBody);

    const { messages, systemPrompt, selectedServerIds } = body;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        selectedServerIds,
        WEB_CALL_TIMEOUT_MS,
        body.oauthTokens,
        body.clientCapabilities,
      ),
      async (manager) => {
        return buildXRayPayload(
          manager,
          selectedServerIds,
          messages,
          systemPrompt,
        );
      },
    );
  });
});

export default xrayPayload;
