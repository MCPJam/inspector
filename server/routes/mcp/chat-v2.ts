import { Hono } from "hono";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";
import { isMCPJamProvidedModel } from "@/shared/types";

const DEFAULT_TEMPERATURE = 0.7;

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as ChatV2Request;
    const mcpClientManager = c.mcpClientManager;
    const { messages, apiKey, model } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages are required" }, 400);
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      return c.json({ error: "model is not supported" }, 400);
    }

    // If model is MCPJam-provided, delegate to backend free-chat endpoint
    if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
      if (!process.env.CONVEX_HTTP_URL) {
        return c.json(
          { error: "Server missing CONVEX_HTTP_URL configuration" },
          500,
        );
      }

      const authHeader = c.req.header("authorization") || undefined;
      const res = await fetch(`${process.env.CONVEX_HTTP_URL}/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          messages,
          model: String(modelDefinition.id),
          temperature: body.temperature ?? DEFAULT_TEMPERATURE,
        }),
      });

      if (!res.ok || !res.body) {
        const errorText = await res
          .text()
          .catch(() => "Failed to start stream");
        return c.json(
          { error: `Backend error: ${errorText || res.statusText}` },
          500,
        );
      }

      // Proxy the backend UI message stream back to the client
      return new Response(res.body, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const llmModel = createLlmModel(
      modelDefinition,
      apiKey ?? "",
      body.ollamaBaseUrl,
      body.litellmBaseUrl,
    );

    const result = streamText({
      model: llmModel,
      messages: convertToModelMessages(messages),
      temperature: body.temperature ?? DEFAULT_TEMPERATURE,
      tools: await mcpClientManager.getToolsForAiSdk(),
      stopWhen: stepCountIs(20),
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error("[mcp/chat-v2] failed to process chat request", error);
    return c.json({ error: "Unexpected error" }, 500);
  }
});

export default chatV2;
