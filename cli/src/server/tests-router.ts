import { Hono } from "hono";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { MCPClient } from "@mastra/mcp";
import { Agent } from "@mastra/core/agent";

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
              apiKey: providerApiKeys?.anthropic || process.env.ANTHROPIC_API_KEY || "",
            })(model.id);
          case "openai":
            return createOpenAI({
              apiKey: providerApiKeys?.openai || process.env.OPENAI_API_KEY || "",
            })(model.id);
          case "deepseek":
            return createOpenAI({
              apiKey: providerApiKeys?.deepseek || process.env.DEEPSEEK_API_KEY || "",
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

          for (const test of testsInput) {
            const calledTools = new Set<string>();
            const expectedSet = new Set<string>(test.expectedTools || []);
            let client: MCPClient | null = null;

            try {
              // Build servers for this test
              let serverConfigs = {};
              if (test.selectedServers && test.selectedServers.length > 0) {
                for (const name of test.selectedServers) {
                  if (allServers[name]) serverConfigs[name] = allServers[name];
                }
              } else {
                serverConfigs = allServers;
              }

              if (Object.keys(serverConfigs).length === 0) {
                throw new Error("No valid MCP server configs for test");
              }

              client = new MCPClient({ servers: serverConfigs });
              const model = createModel(test.model);
              const agent = new Agent({
                name: `TestAgent-${test.id}`,
                instructions: "You are a helpful assistant with access to MCP tools",
                model,
              });

              const toolsets = await client.getToolsets();
              const stream = await agent.stream(
                [{ role: "user", content: test.prompt || "" }] as any,
                {
                  maxSteps: 10,
                  toolsets,
                  onStepFinish: ({ text, toolCalls, toolResults }) => {
                    // Accumulate tool names
                    (toolCalls || []).forEach((c: any) => {
                      const toolName = c?.name || c?.toolName;
                      if (toolName) {
                        calledTools.add(toolName);
                      }
                    });
                  },
                }
              );

              // Drain the stream
              for await (const _ of stream.textStream) {
                // no-op
              }

              const called = Array.from(calledTools);
              const missing = Array.from(expectedSet).filter(
                (t) => !calledTools.has(t)
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
                  })}\n\n`
                )
              );
            } catch (err) {
              failed = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "result",
                    testId: test.id,
                    passed: false,
                    error: (err as Error)?.message,
                  })}\n\n`
                )
              );
            } finally {
              try {
                await client?.disconnect();
              } catch {}
            }
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "run_complete",
                passed: !failed,
              })}\n\n`
            )
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
        500
      );
    }
  });

  return tests;
}