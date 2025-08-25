import { Hono } from "hono";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { MastraMCPServerDefinition, MCPClient } from "@mastra/mcp";
import type { ModelDefinition } from "../../../shared/types";
import { Agent } from "@mastra/core/agent";
import {
  normalizeServerConfigName,
  validateMultipleServerConfigs,
  createMCPClientWithMultipleConnections,
} from "../../utils/mcp-utils";

const tests = new Hono();

// Generate a @TestAgent.ts file for a saved test with selected servers
tests.post("/generate", async (c) => {
  try {
    const body = await c.req.json();
    const test = body?.test;
    const servers = body?.servers as Record<string, any>;
    const model = body?.model as { id: string; provider: string } | undefined;

    if (
      !test?.id ||
      !test?.prompt ||
      !servers ||
      Object.keys(servers).length === 0
    ) {
      return c.json(
        { success: false, error: "Missing test, servers, or prompt" },
        400,
      );
    }

    const safeName = String(test.title || test.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const filename = `@TestAgent_${safeName || test.id}.ts`;

    const fileContents = `import { Agent } from "@mastra/core/agent";
import { MCPClient } from "@mastra/mcp";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";

const servers = ${JSON.stringify(servers, null, 2)} as const;

function createModel() {
  const def = ${JSON.stringify(model || null)} as any;
  if (!def) throw new Error("Model not provided by UI when generating test agent");
  switch (def.provider) {
    case "anthropic": return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(def.id);
    case "openai": return createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(def.id);
    case "deepseek": return createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" })(def.id);
    case "ollama": return createOllama({ baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434" })(def.id, { simulateStreaming: true });
    default: throw new Error("Unsupported provider: " + def.provider);
  }
}

export const createTestAgent = async () => {
  const mcp = new MCPClient({ servers });
  const toolsets = await mcp.getToolsets();
  return new Agent({
    name: ${JSON.stringify(test.title || "Test Agent")},
    instructions: ${JSON.stringify(test.prompt)},
    model: createModel(),
    tools: undefined,
    defaultGenerateOptions: { toolChoice: "auto" }
  });
};
`;

    const targetPath = join(process.cwd(), "server", "agents", filename);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, fileContents, "utf8");
    return c.json({ success: true, file: `server/agents/${filename}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return c.json({ success: false, error: msg }, 500);
  }
});

export default tests;

// Run-all (parallel orchestrated) endpoint
tests.post("/run-all", async (c) => {
  const encoder = new TextEncoder();
  try {
    const body = await c.req.json();
    const testsInput = (body?.tests || []) as Array<{
      id: string;
      title: string;
      prompt: string;
      expectedTools: string[];
      model: ModelDefinition;
      selectedServers?: string[];
    }>;
    const allServers = (body?.allServers || {}) as Record<
      string,
      MastraMCPServerDefinition
    >;
    const providerApiKeys = body?.providerApiKeys || {};
    const ollamaBaseUrl: string | undefined = body?.ollamaBaseUrl;
    const maxConcurrency: number = Math.max(
      1,
      Math.min(8, body?.concurrency ?? 5),
    );

    if (!Array.isArray(testsInput) || testsInput.length === 0) {
      return c.json({ success: false, error: "No tests provided" }, 400);
    }

    function createModel(model: ModelDefinition) {
      switch (model.provider) {
        case "anthropic":
          return createAnthropic({
            apiKey:
              providerApiKeys?.anthropic || process.env.ANTHROPIC_API_KEY || "",
          })(model.id);
        case "openai":
          return createOpenAI({
            apiKey: providerApiKeys?.openai || process.env.OPENAI_API_KEY || "",
          })(model.id);
        case "deepseek":
          return createOpenAI({
            apiKey:
              providerApiKeys?.deepseek || process.env.DEEPSEEK_API_KEY || "",
            baseURL: "https://api.deepseek.com/v1",
          })(model.id);
        case "ollama":
          return createOllama({
            baseURL:
              ollamaBaseUrl ||
              process.env.OLLAMA_BASE_URL ||
              "http://localhost:11434",
          })(model.id, { simulateStreaming: true });
        default:
          throw new Error(`Unsupported provider: ${model.provider}`);
      }
    }

    const readableStream = new ReadableStream({
      async start(controller) {
        let active = 0;
        let index = 0;
        let failed = false;

        const runNext = async () => {
          if (index >= testsInput.length) {
            if (active === 0) {
              // All done
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "run_complete", passed: !failed })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              controller.close();
            }
            return;
          }
          const test = testsInput[index++];
          active++;
          (async () => {
            const calledTools = new Set<string>();
            const expectedSet = new Set<string>(test.expectedTools || []);
            let step = 0;
            let client: MCPClient | null = null;
            try {
              // Build servers for this test
              let serverConfigs: Record<string, MastraMCPServerDefinition> = {};
              if (test.selectedServers && test.selectedServers.length > 0) {
                for (const name of test.selectedServers) {
                  if (allServers[name]) serverConfigs[name] = allServers[name];
                }
              } else {
                for (const [name, cfg] of Object.entries(allServers)) {
                  serverConfigs[name] = cfg;
                }
              }

              // Validate and connect with multiple servers like chat endpoint to ensure headers/eventSourceInit are set
              const validation = validateMultipleServerConfigs(serverConfigs);
              let finalServers: Record<string, MastraMCPServerDefinition> = {};
              if (validation.success && validation.validConfigs) {
                finalServers = validation.validConfigs;
              } else if (
                validation.validConfigs &&
                Object.keys(validation.validConfigs).length > 0
              ) {
                finalServers = validation.validConfigs; // partial success; continue with valid ones
              } else {
                throw new Error("No valid MCP server configs for test");
              }

              client = createMCPClientWithMultipleConnections(finalServers);
              const model = createModel(test.model);
              const agent = new Agent({
                name: `TestAgent-${test.id}`,
                instructions:
                  "You are a helpful assistant with access to MCP tools",
                model,
              });
              const toolsets = await client.getToolsets();
              const stream = await agent.stream(
                [{ role: "user", content: test.prompt || "" }] as any,
                {
                  maxSteps: 10,
                  toolsets,
                  onStepFinish: ({ text, toolCalls, toolResults }) => {
                    step += 1;
                    // Accumulate tool names
                    (toolCalls || []).forEach((c: any) => {
                      const toolName = c?.name || c?.toolName;
                      if (toolName) {
                        calledTools.add(toolName);
                      }
                    });
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({
                          type: "trace_step",
                          testId: test.id,
                          step,
                          text,
                          toolCalls,
                          toolResults,
                        })}\n\n`,
                      ),
                    );
                  },
                },
              );
              // Drain text (no need to forward text here)
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
                  `data: ${JSON.stringify({ type: "result", testId: test.id, passed, calledTools: called, missingTools: missing, unexpectedTools: unexpected })}\n\n`,
                ),
              );
            } catch (err) {
              failed = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "result", testId: test.id, passed: false, error: (err as Error)?.message })}\n\n`,
                ),
              );
            } finally {
              try {
                await client?.disconnect();
              } catch {}
              active--;
              runNext();
            }
          })();
        };

        for (let i = 0; i < Math.min(maxConcurrency, testsInput.length); i++) {
          runNext();
        }
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
