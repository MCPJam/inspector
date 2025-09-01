import { Hono } from "hono";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { Agent } from "@mastra/core/agent";
import { MCPJamClientManager } from "../../../server/services/mcpjam-client-manager.js";
import { Logger } from "../utils/logger.js";

// Simplified version of the server's tests router for CLI use
export function createTestsRouter() {
  const tests = new Hono();

  tests.post("/run-all", async (c) => {
    const encoder = new TextEncoder();
    try {
      const body = await c.req.json();
      const testsInput = (body?.tests || []) as Array<{
        id: string;
        title: string;
        prompt: string;
        expectedTools: string[];
        model: { id: string; provider: string };
        selectedServers?: string[];
      }>;
      const allServers = body?.allServers || {};
      const providerApiKeys = body?.providerApiKeys || {};

      if (!Array.isArray(testsInput) || testsInput.length === 0) {
        return c.json({ success: false, error: "No tests provided" }, 400);
      }

      function createModel(model: { id: string; provider: string }) {
        let apiKey: string | undefined;

        switch (model.provider) {
          case "anthropic":
            apiKey =
              providerApiKeys?.anthropic || process.env.ANTHROPIC_API_KEY;
            if (!apiKey) {
              throw new Error(
                "Missing Anthropic API key. Set ANTHROPIC_API_KEY environment variable or provide in environment file.",
              );
            }
            return createAnthropic({ apiKey })(model.id);
          case "openai":
            apiKey = providerApiKeys?.openai || process.env.OPENAI_API_KEY;
            if (!apiKey) {
              throw new Error(
                "Missing OpenAI API key. Set OPENAI_API_KEY environment variable or provide in environment file.",
              );
            }
            return createOpenAI({ apiKey })(model.id);
          case "deepseek":
            apiKey = providerApiKeys?.deepseek || process.env.DEEPSEEK_API_KEY;
            if (!apiKey) {
              throw new Error(
                "Missing DeepSeek API key. Set DEEPSEEK_API_KEY environment variable or provide in environment file.",
              );
            }
            return createOpenAI({
              apiKey,
              baseURL: "https://api.deepseek.com/v1",
            })(model.id);
          case "ollama":
            // Ollama doesn't require API key, but check if server is accessible
            return createOllama({
              baseURL:
                process.env.OLLAMA_BASE_URL || "http://localhost:11434/api",
            })(model.id, { simulateStreaming: true });
          default:
            throw new Error(`Unsupported provider: ${model.provider}`);
        }
      }

      const readableStream = new ReadableStream({
        async start(controller) {
          let failed = false;

          const clientManager = new MCPJamClientManager();

          for (const test of testsInput) {
            Logger.testStarting(test.title);
            const calledTools = new Set<string>();
            const expectedSet = new Set<string>(test.expectedTools || []);

            // Build servers for this test - keep in outer scope for cleanup
            let serverConfigs: Record<string, any> = {};
            if (test.selectedServers && test.selectedServers.length > 0) {
              for (const name of test.selectedServers) {
                if (allServers[name]) serverConfigs[name] = allServers[name];
              }
            } else {
              serverConfigs = allServers;
            }

            if (Object.keys(serverConfigs).length === 0) {
              Logger.testError(test.title, "No valid MCP server configs");
              continue;
            }

            try {
              // Connect to all servers for this test using the client manager (like chat route)
              for (const [serverName, serverConfig] of Object.entries(
                serverConfigs,
              )) {
                await clientManager.connectToServer(serverName, serverConfig);
              }

              // Create model with better error handling
              let model;
              try {
                model = createModel(test.model);
              } catch (modelErr) {
                const errorMessage =
                  (modelErr as Error)?.message ||
                  "Unknown model creation error";

                // Check if it's an API key error
                if (errorMessage.includes("API key")) {
                  throw new Error(
                    `Invalid or missing API key for ${test.model.provider}`,
                  );
                }
                // Check for authentication errors from the providers
                else if (
                  errorMessage.includes("401") ||
                  errorMessage.includes("unauthorized") ||
                  errorMessage.includes("authentication")
                ) {
                  throw new Error(
                    `Authentication failed for ${test.model.provider}. Check your API key.`,
                  );
                }
                // Check for invalid model errors
                else if (
                  errorMessage.includes("model") &&
                  errorMessage.includes("not found")
                ) {
                  throw new Error(
                    `Model "${test.model.id}" not found for ${test.model.provider}`,
                  );
                } else {
                  throw new Error(
                    `Failed to create ${test.model.provider} model: ${errorMessage}`,
                  );
                }
              }

              // Get available tools and create the tool structure like chat.ts
              const allTools = clientManager.getAvailableTools();
              const toolsByServer: Record<string, any> = {};

              // Group tools by server for the agent (like chat route)
              for (const tool of allTools) {
                if (!toolsByServer[tool.serverId]) {
                  toolsByServer[tool.serverId] = {};
                }
                toolsByServer[tool.serverId][tool.name] = {
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  execute: async (params: any) => {
                    const result = await clientManager.executeToolDirect(
                      `${tool.serverId}:${tool.name}`,
                      params,
                    );
                    return result.result;
                  },
                };
              }

              Logger.serverConnection(
                Object.keys(toolsByServer).length,
                allTools.length,
              );

              const agent = new Agent({
                name: `TestAgent-${test.id}`,
                instructions:
                  "You are a helpful assistant with access to MCP tools",
                model,
              });

              const streamOptions: any = {
                maxSteps: 10,
                toolsets: toolsByServer,
                onStepFinish: ({
                  text,
                  toolCalls,
                  toolResults,
                }: {
                  text: string;
                  toolCalls?: any[];
                  toolResults?: any[];
                }) => {
                  // Accumulate tool names
                  (toolCalls || []).forEach((c: any) => {
                    const toolName = c?.name || c?.toolName;
                    if (toolName) {
                      calledTools.add(toolName);
                    }
                  });
                },
              };
              // Only set toolChoice if explicitly configured, don't force "required"
              const tAny = test as any;
              if (tAny?.advancedConfig?.toolChoice) {
                streamOptions.toolChoice = tAny.advancedConfig.toolChoice;
              }
              const stream = await agent.stream(
                [{ role: "user", content: test.prompt || "" }] as any,
                streamOptions,
              );

              // Drain the stream
              for await (const _ of stream.textStream) {
                // no-op
              }

              const called = Array.from(calledTools);
              const missing = Array.from(expectedSet).filter(
                (t) => !calledTools.has(t),
              );
              const unexpected = called.filter((t) => !expectedSet.has(t));
              const passed = missing.length === 0 && unexpected.length === 0;

              if (!passed) failed = true;

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "result",
                    testId: test.id,
                    passed,
                    calledTools: called,
                    missingTools: missing,
                    unexpectedTools: unexpected,
                  })}\n\n`,
                ),
              );
            } catch (err) {
              const errorMessage = (err as Error)?.message || "Unknown error";
              Logger.testError(test.title, errorMessage);
              failed = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "result",
                    testId: test.id,
                    passed: false,
                    error: errorMessage,
                  })}\n\n`,
                ),
              );
            } finally {
              // Clean disconnect without verbose logging
              for (const serverName of Object.keys(serverConfigs)) {
                try {
                  await clientManager.disconnectFromServer(serverName);
                } catch (disconnectErr) {
                  // Only log connection errors if they're critical
                  const errorMessage =
                    (disconnectErr as Error)?.message ||
                    "Unknown disconnect error";
                  Logger.connectionError(serverName, errorMessage);
                }
              }
            }
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "run_complete",
                passed: !failed,
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });

      return new Response(readableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (err) {
      return c.json(
        { success: false, error: (err as Error)?.message || "Unknown error" },
        500,
      );
    }
  });

  return tests;
}
