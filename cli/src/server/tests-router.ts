import { Hono } from "hono";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { Agent } from "@mastra/core/agent";
import { MCPJamClientManager } from "../../../server/services/mcpjam-client-manager.js";

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
        switch (model.provider) {
          case "anthropic":
            return createAnthropic({
              apiKey:
                providerApiKeys?.anthropic ||
                process.env.ANTHROPIC_API_KEY ||
                "",
            })(model.id);
          case "openai":
            return createOpenAI({
              apiKey:
                providerApiKeys?.openai || process.env.OPENAI_API_KEY || "",
            })(model.id);
          case "deepseek":
            return createOpenAI({
              apiKey:
                providerApiKeys?.deepseek || process.env.DEEPSEEK_API_KEY || "",
              baseURL: "https://api.deepseek.com/v1",
            })(model.id);
          case "ollama":
            return createOllama({
              baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
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
            console.log(`🔍 Starting test: ${test.title}`);
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

            console.log(
              `📋 Test ${test.title} using servers: ${Object.keys(serverConfigs).join(", ")}`,
            );

            if (Object.keys(serverConfigs).length === 0) {
              console.error(
                `❌ No valid MCP server configs for test ${test.title}`,
              );
              continue;
            }

            try {
              // Connect to all servers for this test using the client manager (like chat route)
              console.log(`🔌 Connecting to servers for ${test.title}...`);
              for (const [serverName, serverConfig] of Object.entries(
                serverConfigs,
              )) {
                console.log(`   Connecting to ${serverName}...`);
                await clientManager.connectToServer(serverName, serverConfig);
                console.log(`   ✅ Connected to ${serverName}`);
              }

              console.log(
                `🤖 Creating model ${test.model.provider}:${test.model.id}...`,
              );
              const model = createModel(test.model);

              console.log(`🛠️  Getting tools for ${test.title}...`);

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

              console.log(
                `✅ Got ${allTools.length} total tools across ${Object.keys(toolsByServer).length} servers`,
              );
              // Map unique server IDs back to original names for readability using client manager helper
              console.log(
                `🔍 Servers:`,
                clientManager.mapIdsToOriginalNames(Object.keys(toolsByServer)),
              );

              const agent = new Agent({
                name: `TestAgent-${test.id}`,
                instructions:
                  "You are a helpful assistant with access to MCP tools",
                model,
              });

              console.log(`💬 Starting agent stream for ${test.title}...`);
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
                  if (toolCalls && toolCalls.length) {
                    console.log(
                      `🛠️  Tool calls:`,
                      toolCalls.map((c: any) => c?.name || c?.toolName),
                    );
                  }
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
              console.log(`📄 Draining text stream for ${test.title}...`);
              for await (const _ of stream.textStream) {
                // no-op
              }
              console.log(`✅ Stream completed for ${test.title}`);

              const called = Array.from(calledTools);
              const missing = Array.from(expectedSet).filter(
                (t) => !calledTools.has(t),
              );
              const unexpected = called.filter((t) => !expectedSet.has(t));
              const passed = missing.length === 0 && unexpected.length === 0;

              console.log(
                `📊 Test ${test.title} result: ${passed ? "PASSED" : "FAILED"}`,
              );
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
              console.error(`❌ Test ${test.title} failed:`, err);
              failed = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "result",
                    testId: test.id,
                    passed: false,
                    error: (err as Error)?.message,
                  })}\n\n`,
                ),
              );
            } finally {
              console.log(`🔌 Disconnecting servers for ${test.title}...`);
              for (const serverName of Object.keys(serverConfigs)) {
                try {
                  await clientManager.disconnectFromServer(serverName);
                  console.log(`   ✅ Disconnected from ${serverName}`);
                } catch (disconnectErr) {
                  console.log(
                    `   ⚠️  Disconnect error from ${serverName}:`,
                    disconnectErr,
                  );
                }
              }
              console.log(`✅ Test ${test.title} cleanup complete`);
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
