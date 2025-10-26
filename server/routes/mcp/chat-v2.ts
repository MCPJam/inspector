import { Hono } from "hono";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";

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
