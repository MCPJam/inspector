import { NextRequest } from "next/server";
import {
  validateServerConfig,
  createMCPClient,
  createErrorResponse,
} from "@/lib/mcp-utils";
import { Agent } from "@mastra/core/agent";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { ChatMessage } from "@/lib/chat-types";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig, model, apiKey, systemPrompt, messages } =
      await request.json();

    if (!model || !apiKey || !messages) {
      return createErrorResponse(
        "Missing required fields",
        "model, apiKey, and messages are required",
      );
    }

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    const client = createMCPClient(validation.config!, `chat-${Date.now()}`);

    try {
      const llmModel = getLlmModel(model, apiKey);
      const tools = await client.getTools();

      // Create a Mastra agent with the MCP tools
      const agent = new Agent({
        name: "MCP Chat Agent",
        instructions:
          systemPrompt ||
          "You are a helpful assistant with access to MCP tools.",
        model: llmModel,
        tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
      });

      // Convert ChatMessage[] to the format expected by Mastra Agent
      const formattedMessages = messages.map((msg: ChatMessage) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Check if streaming is requested
      const stream = await agent.stream(formattedMessages);

      // Create a ReadableStream for streaming response
      const encoder = new TextEncoder();
      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream.textStream) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
            }
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          } catch (error) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } catch (error) {
      console.error("Chat completion error:", error);
      return createErrorResponse(
        "Chat completion failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      // Clean up the MCP client connection
      try {
        await client.disconnect();
      } catch (cleanupError) {
        console.warn("Error cleaning up MCP client:", cleanupError);
      }
    }
  } catch (error) {
    console.error("Error in chat API:", error);
    return createErrorResponse(
      "Failed to process chat request",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

const getLlmModel = (model: string, apiKey: string) => {
  switch (model) {
    case "claude-3-5-sonnet-20240620":
      return createAnthropic({ apiKey })(model);
    case "gpt-4o-mini":
      return createOpenAI({ apiKey })(model);
    default:
      throw new Error(`Unsupported model: ${model}`);
  }
};
