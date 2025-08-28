// src/index.ts
import { Command as Command2 } from "commander";

// src/commands/evals.ts
import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";

// schemas/test-schema.ts
import { z } from "zod";
var ModelSchema = z.object({
  id: z.string(),
  provider: z.enum(["openai", "anthropic", "deepseek", "ollama"])
});
var AdvancedConfigSchema = z.object({
  instructions: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().positive().optional(),
  toolChoice: z.enum(["auto", "required", "none"]).optional()
});
var TestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  expectedTools: z.array(z.string()),
  model: ModelSchema,
  selectedServers: z.array(z.string()),
  advancedConfig: AdvancedConfigSchema.optional()
});
var TestsFileSchema = z.object({
  tests: z.array(TestSchema)
});

// schemas/environment-schema.ts
import { z as z2 } from "zod";
var MCPServerConfigSchema = z2.union([
  // STDIO server
  z2.object({
    command: z2.string(),
    args: z2.array(z2.string()).optional(),
    env: z2.record(z2.string()).optional()
  }),
  // HTTP server
  z2.object({
    url: z2.string().url(),
    headers: z2.record(z2.string()).optional()
  })
]);
var EnvironmentFileSchema = z2.object({
  mcpServers: z2.record(MCPServerConfigSchema),
  providerApiKeys: z2.object({
    anthropic: z2.string().optional(),
    openai: z2.string().optional(),
    deepseek: z2.string().optional()
  }).optional()
});

// src/runner/test-runner.ts
import { serve } from "@hono/node-server";
import { Hono as Hono2 } from "hono";

// src/server/tests-router.ts
import { Hono } from "hono";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { MCPClient } from "@mastra/mcp";
import { Agent } from "@mastra/core/agent";
function createTestsRouter() {
  const tests = new Hono();
  tests.post("/run-all", async (c) => {
    const encoder = new TextEncoder();
    try {
      let createModel2 = function(model) {
        switch (model.provider) {
          case "anthropic":
            return createAnthropic({
              apiKey: providerApiKeys?.anthropic || process.env.ANTHROPIC_API_KEY || ""
            })(model.id);
          case "openai":
            return createOpenAI({
              apiKey: providerApiKeys?.openai || process.env.OPENAI_API_KEY || ""
            })(model.id);
          case "deepseek":
            return createOpenAI({
              apiKey: providerApiKeys?.deepseek || process.env.DEEPSEEK_API_KEY || "",
              baseURL: "https://api.deepseek.com/v1"
            })(model.id);
          case "ollama":
            return createOllama({
              baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434"
            })(model.id, { simulateStreaming: true });
          default:
            throw new Error(`Unsupported provider: ${model.provider}`);
        }
      };
      var createModel = createModel2;
      const body = await c.req.json();
      const testsInput = body?.tests || [];
      const allServers = body?.allServers || {};
      const providerApiKeys = body?.providerApiKeys || {};
      if (!Array.isArray(testsInput) || testsInput.length === 0) {
        return c.json({ success: false, error: "No tests provided" }, 400);
      }
      const readableStream = new ReadableStream({
        async start(controller) {
          let failed = false;
          for (const test of testsInput) {
            const calledTools = /* @__PURE__ */ new Set();
            const expectedSet = new Set(test.expectedTools || []);
            let client = null;
            try {
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
              const model = createModel2(test.model);
              const agent = new Agent({
                name: `TestAgent-${test.id}`,
                instructions: "You are a helpful assistant with access to MCP tools",
                model
              });
              const toolsets = await client.getToolsets();
              const stream = await agent.stream(
                [{ role: "user", content: test.prompt || "" }],
                {
                  maxSteps: 10,
                  toolsets,
                  onStepFinish: ({ text, toolCalls, toolResults }) => {
                    (toolCalls || []).forEach((c2) => {
                      const toolName = c2?.name || c2?.toolName;
                      if (toolName) {
                        calledTools.add(toolName);
                      }
                    });
                  }
                }
              );
              for await (const _ of stream.textStream) {
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
                    unexpectedTools: unexpected
                  })}

`
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
                    error: err?.message
                  })}

`
                )
              );
            } finally {
              try {
                await client?.disconnect();
              } catch {
              }
            }
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "run_complete",
                passed: !failed
              })}

`
            )
          );
          controller.enqueue(encoder.encode(`data: [DONE]

`));
          controller.close();
        }
      });
      return new Response(readableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        }
      });
    } catch (err) {
      return c.json(
        { success: false, error: err?.message || "Unknown error" },
        500
      );
    }
  });
  return tests;
}

// src/runner/test-runner.ts
async function runTests(tests, environment) {
  const startTime = Date.now();
  const app = new Hono2();
  app.route("/mcp/tests", createTestsRouter());
  const server = serve({
    fetch: app.fetch,
    port: 0
    // Use random available port
  });
  const port = server.port || 3e3;
  try {
    const backendTests = tests.map((test, index) => ({
      id: `test_${index}`,
      title: test.title,
      prompt: test.prompt,
      expectedTools: test.expectedTools,
      model: test.model,
      selectedServers: test.selectedServers
    }));
    const backendServers = Object.fromEntries(
      Object.entries(environment.mcpServers).map(([name, config]) => [
        name,
        convertServerConfig(config)
      ])
    );
    const payload = {
      tests: backendTests,
      allServers: backendServers,
      providerApiKeys: environment.providerApiKeys || {}
    };
    const response = await fetch(`http://localhost:${port}/mcp/tests/run-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`Server error: ${response.status} ${response.statusText}`);
    }
    const results = await processStreamingResults(response, tests);
    const duration = ((Date.now() - startTime) / 1e3).toFixed(1);
    return {
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      duration,
      results
    };
  } finally {
    server.close();
  }
}
function convertServerConfig(config) {
  if ("command" in config) {
    return {
      command: config.command,
      args: config.args || [],
      env: config.env || {}
    };
  } else {
    return {
      url: config.url,
      headers: config.headers || {}
    };
  }
}
async function processStreamingResults(response, tests) {
  const results = [];
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  if (!reader) {
    throw new Error("No response body");
  }
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") break;
        try {
          const event = JSON.parse(data);
          if (event.type === "result") {
            const testIndex = parseInt(event.testId.split("_")[1]);
            const test = tests[testIndex];
            const testStart = Date.now();
            const result = {
              testId: event.testId,
              title: test?.title || "Unknown Test",
              passed: event.passed,
              calledTools: event.calledTools || [],
              missingTools: event.missingTools || [],
              unexpectedTools: event.unexpectedTools || [],
              error: event.error,
              duration: 0
              // We don't have individual timing from the stream
            };
            results.push(result);
            if (result.passed) {
              console.log(`\u2705 ${result.title}`);
              console.log(`   Called tools: ${result.calledTools.join(", ") || "none"}`);
            } else {
              console.log(`\u274C ${result.title}`);
              if (result.error) {
                console.log(`   Error: ${result.error}`);
              } else {
                console.log(`   Called tools: ${result.calledTools.join(", ") || "none"}`);
                if (result.missingTools.length > 0) {
                  console.log(`   Missing: ${result.missingTools.join(", ")}`);
                }
                if (result.unexpectedTools.length > 0) {
                  console.log(`   Unexpected: ${result.unexpectedTools.join(", ")}`);
                }
              }
            }
          } else if (event.type === "trace_step") {
          }
        } catch (e) {
        }
      }
    }
  }
  return results;
}

// src/utils/env-resolver.ts
function resolveEnvironmentVariables(env) {
  return {
    ...env,
    mcpServers: Object.fromEntries(
      Object.entries(env.mcpServers).map(([name, config]) => [
        name,
        resolveServerConfig(config)
      ])
    ),
    providerApiKeys: env.providerApiKeys ? {
      anthropic: resolveTemplate(env.providerApiKeys.anthropic),
      openai: resolveTemplate(env.providerApiKeys.openai),
      deepseek: resolveTemplate(env.providerApiKeys.deepseek)
    } : void 0
  };
}
function resolveServerConfig(config) {
  if ("command" in config) {
    return {
      ...config,
      env: config.env ? Object.fromEntries(
        Object.entries(config.env).map(([key, value]) => [
          key,
          resolveTemplate(value)
        ])
      ) : void 0
    };
  } else {
    return {
      ...config,
      headers: config.headers ? Object.fromEntries(
        Object.entries(config.headers).map(([key, value]) => [
          key,
          resolveTemplate(value)
        ])
      ) : void 0
    };
  }
}
function resolveTemplate(value) {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const resolved = process.env[envVar];
    if (resolved === void 0) {
      console.warn(`\u26A0\uFE0F  Warning: Environment variable ${envVar} is not set`);
      return match;
    }
    return resolved;
  });
}

// src/commands/evals.ts
var evalsCommand = new Command("evals");
evalsCommand.description("Run MCP evaluations").command("run").description("Run tests against MCP servers").requiredOption("-t, --tests <file>", "Path to tests JSON file").requiredOption("-e, --environment <file>", "Path to environment JSON file").action(async (options) => {
  try {
    console.log("MCPJAM Evals v1.0.0\n");
    const testsContent = await readFile(resolve(options.tests), "utf8");
    const testsData = TestsFileSchema.parse(JSON.parse(testsContent));
    const envContent = await readFile(resolve(options.environment), "utf8");
    const envData = EnvironmentFileSchema.parse(JSON.parse(envContent));
    const resolvedEnv = resolveEnvironmentVariables(envData);
    console.log(`Running ${testsData.tests.length} tests...
`);
    const results = await runTests(testsData.tests, resolvedEnv);
    console.log(`
Results: ${results.passed} passed, ${results.failed} failed (${results.duration}s total)
`);
    if (results.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error("\u274C Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});

// src/index.ts
var program = new Command2();
program.name("mcpjam").description("MCPJam CLI for programmatic MCP testing").version("1.0.0");
program.addCommand(evalsCommand);
program.parse();
//# sourceMappingURL=index.js.map