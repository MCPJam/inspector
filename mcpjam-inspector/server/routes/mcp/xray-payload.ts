/**
 * X-Ray Payload Endpoint
 *
 * Returns the actual payload that would be sent to the AI model,
 * including the enhanced system prompt and all tools (MCP + skill tools).
 */

import { Hono } from "hono";
import type { UIMessage } from "ai";
import { buildXRayPayload } from "../../utils/xray-helpers";

interface XRayPayloadRequest {
  messages: UIMessage[];
  systemPrompt?: string;
  selectedServers?: string[];
}

const xrayPayload = new Hono();

xrayPayload.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as XRayPayloadRequest;
    const mcpClientManager = c.mcpClientManager;
    const { messages, systemPrompt, selectedServers } = body;

    const response = await buildXRayPayload(
      mcpClientManager,
      selectedServers ?? [],
      messages ?? [],
      systemPrompt,
    );

    return c.json(response);
  } catch (error) {
    console.error("[mcp/xray-payload] failed to build payload", error);
    return c.json({ error: "Failed to build X-Ray payload" }, 500);
  }
});

export default xrayPayload;
