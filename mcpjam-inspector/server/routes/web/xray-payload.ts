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
import { buildXRayPayload } from "../../utils/xray-helpers.js";
import {
  hostedChatSchema,
  createAuthorizedManager,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  handleRoute,
  withManager,
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
    const body = parseWithSchema(
      xrayPayloadSchema,
      await readJsonBody<unknown>(c),
    );

    const { messages, systemPrompt, selectedServerIds } = body;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        selectedServerIds,
        WEB_CALL_TIMEOUT_MS,
        body.oauthTokens,
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
