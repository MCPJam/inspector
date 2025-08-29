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
  provider: z.enum(["openai", "anthropic", "deepseek", "ollama"]),
});
var AdvancedConfigSchema = z.object({
  instructions: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().positive().optional(),
  toolChoice: z.enum(["auto", "required", "none"]).optional(),
});
var TestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  expectedTools: z.array(z.string()),
  model: ModelSchema,
  selectedServers: z.array(z.string()),
  advancedConfig: AdvancedConfigSchema.optional(),
});
var TestsFileSchema = z.object({
  tests: z.array(TestSchema),
});

// schemas/environment-schema.ts
import { z as z2 } from "zod";
var MCPServerConfigSchema = z2.union([
  // STDIO server
  z2.object({
    command: z2.string(),
    args: z2.array(z2.string()).optional(),
    env: z2.record(z2.string()).optional(),
  }),
  // HTTP server
  z2.object({
    url: z2.string().url(),
    headers: z2.record(z2.string()).optional(),
  }),
]);
var EnvironmentFileSchema = z2.object({
  mcpServers: z2.record(MCPServerConfigSchema),
  providerApiKeys: z2
    .object({
      anthropic: z2.string().optional(),
      openai: z2.string().optional(),
      deepseek: z2.string().optional(),
    })
    .optional(),
});

// src/runner/test-runner.ts
import { createServer } from "http";
import { serve } from "@hono/node-server";
import { Hono as Hono2 } from "hono";

// src/server/tests-router.ts
import { Hono } from "hono";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { Agent } from "@mastra/core/agent";

// ../server/services/mcpjam-client-manager.ts
import { MCPClient as MCPClient2 } from "@mastra/mcp";

// ../server/utils/mcp-utils.ts
import { MCPClient } from "@mastra/mcp";
function validateServerConfig(serverConfig) {
  if (!serverConfig) {
    return {
      success: false,
      error: {
        message: "Server configuration is required",
        status: 400,
      },
    };
  }
  const config = { ...serverConfig };
  if (config.url) {
    try {
      if (typeof config.url === "string") {
        const parsed = new URL(config.url);
        parsed.search = "";
        parsed.hash = "";
        config.url = parsed;
      } else if (typeof config.url === "object" && !config.url.href) {
        return {
          success: false,
          error: {
            message: "Invalid URL configuration",
            status: 400,
          },
        };
      }
      if (config.oauth?.access_token) {
        const authHeaders = {
          Authorization: `Bearer ${config.oauth.access_token}`,
          ...(config.requestInit?.headers || {}),
        };
        config.requestInit = {
          ...config.requestInit,
          headers: authHeaders,
        };
        config.eventSourceInit = {
          fetch(input, init) {
            const headers = new Headers(init?.headers || {});
            headers.set("Authorization", `Bearer ${config.oauth.access_token}`);
            if (config.requestInit?.headers) {
              const requestHeaders = new Headers(config.requestInit.headers);
              requestHeaders.forEach((value, key) => {
                if (key.toLowerCase() !== "authorization") {
                  headers.set(key, value);
                }
              });
            }
            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      } else if (config.requestInit?.headers) {
        config.eventSourceInit = {
          fetch(input, init) {
            const headers = new Headers(init?.headers || {});
            const requestHeaders = new Headers(config.requestInit.headers);
            requestHeaders.forEach((value, key) => {
              headers.set(key, value);
            });
            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          message: `Invalid URL format: ${error}`,
          status: 400,
        },
      };
    }
  }
  return {
    success: true,
    config,
  };
}

// ../server/services/mcpjam-client-manager.ts
function generateUniqueServerId(serverId) {
  const normalizedBase = serverId
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${normalizedBase}_${timestamp}_${random}`;
}
var MCPJamClientManager = class {
  mcpClients = /* @__PURE__ */ new Map();
  statuses = /* @__PURE__ */ new Map();
  configs = /* @__PURE__ */ new Map();
  // Map original server names to unique IDs
  serverIdMapping = /* @__PURE__ */ new Map();
  // Track in-flight connections to avoid duplicate concurrent connects
  pendingConnections = /* @__PURE__ */ new Map();
  toolRegistry = /* @__PURE__ */ new Map();
  resourceRegistry = /* @__PURE__ */ new Map();
  promptRegistry = /* @__PURE__ */ new Map();
  // Store for pending elicitation requests with Promise resolvers
  pendingElicitations = /* @__PURE__ */ new Map();
  // Optional callback for handling elicitation requests
  elicitationCallback;
  // Helper method to get unique ID for a server name
  getServerUniqueId(serverName) {
    return this.serverIdMapping.get(serverName);
  }
  // Public method to get server ID for external use (like frontend)
  getServerIdForName(serverName) {
    return this.serverIdMapping.get(serverName);
  }
  // Public method to get original server name from a unique server ID
  getOriginalNameForId(uniqueServerId) {
    for (const [originalName, uid] of this.serverIdMapping.entries()) {
      if (uid === uniqueServerId) return originalName;
    }
    return void 0;
  }
  // Convenience: map an array of unique IDs to their original names (fallback to ID if not found)
  mapIdsToOriginalNames(uniqueIds) {
    return uniqueIds.map((id) => this.getOriginalNameForId(id) || id);
  }
  async connectToServer(serverId, serverConfig) {
    const pending = this.pendingConnections.get(serverId);
    if (pending) {
      await pending;
      return;
    }
    const connectPromise = (async () => {
      let id = this.serverIdMapping.get(serverId);
      if (!id) {
        id = generateUniqueServerId(serverId);
        this.serverIdMapping.set(serverId, id);
      }
      if (this.mcpClients.has(id)) return;
      const validation = validateServerConfig(serverConfig);
      if (!validation.success) {
        this.statuses.set(id, "error");
        throw new Error(validation.error.message);
      }
      this.configs.set(id, validation.config);
      this.statuses.set(id, "connecting");
      const client = new MCPClient2({
        id: `mcpjam-${id}`,
        servers: { [id]: validation.config },
      });
      try {
        await client.getTools();
        this.mcpClients.set(id, client);
        this.statuses.set(id, "connected");
        if (client.elicitation?.onRequest) {
          client.elicitation.onRequest(id, async (elicitationRequest) => {
            return await this.handleElicitationRequest(elicitationRequest);
          });
        }
        await this.discoverServerResources(id);
      } catch (err) {
        this.statuses.set(id, "error");
        try {
          await client.disconnect();
        } catch {}
        this.mcpClients.delete(id);
        throw err;
      }
    })().finally(() => {
      this.pendingConnections.delete(serverId);
    });
    this.pendingConnections.set(serverId, connectPromise);
    await connectPromise;
  }
  async disconnectFromServer(serverId) {
    const id = this.getServerUniqueId(serverId);
    if (!id) return;
    const client = this.mcpClients.get(id);
    if (client) {
      try {
        await client.disconnect();
      } catch {}
    }
    this.mcpClients.delete(id);
    this.statuses.set(id, "disconnected");
    this.serverIdMapping.delete(serverId);
    for (const key of Array.from(this.toolRegistry.keys())) {
      const item = this.toolRegistry.get(key);
      if (item.serverId === id) this.toolRegistry.delete(key);
    }
    for (const key of Array.from(this.resourceRegistry.keys())) {
      const item = this.resourceRegistry.get(key);
      if (item.serverId === id) this.resourceRegistry.delete(key);
    }
    for (const key of Array.from(this.promptRegistry.keys())) {
      const item = this.promptRegistry.get(key);
      if (item.serverId === id) this.promptRegistry.delete(key);
    }
  }
  getConnectionStatus(serverId) {
    const id = this.getServerUniqueId(serverId);
    return id ? this.statuses.get(id) || "disconnected" : "disconnected";
  }
  getConnectedServers() {
    const servers = {};
    for (const [originalName, uniqueId] of this.serverIdMapping.entries()) {
      servers[originalName] = {
        status: this.statuses.get(uniqueId) || "disconnected",
        config: this.configs.get(uniqueId),
      };
    }
    return servers;
  }
  async discoverAllResources() {
    const serverIds = Array.from(this.mcpClients.keys());
    await Promise.all(serverIds.map((id) => this.discoverServerResources(id)));
  }
  async discoverServerResources(serverId) {
    const client = this.mcpClients.get(serverId);
    if (!client) return;
    const toolsets = await client.getToolsets();
    const flattenedTools = {};
    Object.values(toolsets).forEach((serverTools) => {
      Object.assign(flattenedTools, serverTools);
    });
    for (const [name, tool] of Object.entries(flattenedTools)) {
      this.toolRegistry.set(`${serverId}:${name}`, {
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        serverId,
      });
    }
    try {
      const res = await client.resources.list();
      for (const [, list] of Object.entries(res)) {
        for (const r of list) {
          this.resourceRegistry.set(`${serverId}:${r.uri}`, {
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            serverId,
          });
        }
      }
    } catch {}
    try {
      const prompts = await client.prompts.list();
      for (const [, list] of Object.entries(prompts)) {
        for (const p of list) {
          this.promptRegistry.set(`${serverId}:${p.name}`, {
            name: p.name,
            description: p.description,
            arguments: p.arguments,
            serverId,
          });
        }
      }
    } catch {}
  }
  getAvailableTools() {
    return Array.from(this.toolRegistry.values());
  }
  async getToolsetsForServer(serverId) {
    const id = this.getServerUniqueId(serverId);
    if (!id) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }
    const client = this.mcpClients.get(id);
    if (!client) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }
    const toolsets = await client.getToolsets();
    const flattenedTools = {};
    Object.values(toolsets).forEach((serverTools) => {
      Object.assign(flattenedTools, serverTools);
    });
    return flattenedTools;
  }
  getAvailableResources() {
    return Array.from(this.resourceRegistry.values());
  }
  getResourcesForServer(serverId) {
    const id = this.getServerUniqueId(serverId);
    if (!id) return [];
    return Array.from(this.resourceRegistry.values()).filter(
      (r) => r.serverId === id,
    );
  }
  getAvailablePrompts() {
    return Array.from(this.promptRegistry.values());
  }
  getPromptsForServer(serverId) {
    const id = this.getServerUniqueId(serverId);
    if (!id) return [];
    return Array.from(this.promptRegistry.values()).filter(
      (p) => p.serverId === id,
    );
  }
  async executeToolDirect(toolName, parameters = {}) {
    let serverId = "";
    let name = toolName;
    if (toolName.includes(":")) {
      const [sid, n] = toolName.split(":", 2);
      const mappedId = this.getServerUniqueId(sid);
      serverId = mappedId || (this.mcpClients.has(sid) ? sid : "");
      name = n;
    } else {
      for (const tool2 of this.toolRegistry.values()) {
        if (tool2.name === toolName) {
          serverId = tool2.serverId;
          name = toolName;
          break;
        }
      }
    }
    if (!serverId) {
      for (const [clientServerId, client2] of this.mcpClients.entries()) {
        try {
          const toolsets2 = await client2.getToolsets();
          const flattenedTools2 = {};
          Object.values(toolsets2).forEach((serverTools) => {
            Object.assign(flattenedTools2, serverTools);
          });
          if (flattenedTools2[toolName]) {
            serverId = clientServerId;
            name = toolName;
            break;
          }
        } catch {}
      }
    }
    if (!serverId) {
      throw new Error(`Tool not found in any connected server: ${toolName}`);
    }
    const client = this.mcpClients.get(serverId);
    if (!client)
      throw new Error(`No MCP client available for server: ${serverId}`);
    const toolsets = await client.getToolsets();
    const flattenedTools = {};
    Object.values(toolsets).forEach((serverTools) => {
      Object.assign(flattenedTools, serverTools);
    });
    const tool = flattenedTools[name];
    if (!tool)
      throw new Error(`Tool '${name}' not found in server '${serverId}'`);
    const schema = tool.inputSchema;
    const hasContextProperty =
      schema &&
      typeof schema === "object" &&
      schema.properties &&
      Object.prototype.hasOwnProperty.call(schema.properties, "context");
    const requiresContext =
      hasContextProperty ||
      (schema &&
        Array.isArray(schema.required) &&
        schema.required.includes("context"));
    const contextWrapped = { context: parameters || {} };
    const direct = parameters || {};
    const attempts = requiresContext
      ? [contextWrapped, direct]
      : [direct, contextWrapped];
    let lastError = void 0;
    for (const args of attempts) {
      try {
        const result = await tool.execute(args);
        return { result };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
  async getResource(resourceUri, serverId) {
    let uri = resourceUri;
    const mappedId = this.getServerUniqueId(serverId);
    const resolvedServerId =
      mappedId || (this.mcpClients.has(serverId) ? serverId : void 0);
    if (!resolvedServerId) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }
    const client = this.mcpClients.get(resolvedServerId);
    if (!client) throw new Error("No MCP client available");
    const content = await client.resources.read(resolvedServerId, uri);
    return { contents: content?.contents || [] };
  }
  async getPrompt(promptName, serverId, args) {
    const mappedId = this.getServerUniqueId(serverId);
    const resolvedServerId =
      mappedId || (this.mcpClients.has(serverId) ? serverId : void 0);
    if (!resolvedServerId) {
      throw new Error(`No MCP client available for server: ${serverId}`);
    }
    const client = this.mcpClients.get(resolvedServerId);
    if (!client) throw new Error("No MCP client available");
    const content = await client.prompts.get({
      serverName: resolvedServerId,
      name: promptName,
      args: args || {},
    });
    return { content };
  }
  /**
   * Handles elicitation requests from MCP servers during direct tool execution
   */
  async handleElicitationRequest(elicitationRequest) {
    const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    return new Promise((resolve2, reject) => {
      this.pendingElicitations.set(requestId, { resolve: resolve2, reject });
      if (this.elicitationCallback) {
        this.elicitationCallback({
          requestId,
          message: elicitationRequest.message,
          schema: elicitationRequest.requestedSchema,
        })
          .then(resolve2)
          .catch(reject);
      } else {
        const error = new Error("ELICITATION_REQUIRED");
        error.elicitationRequest = {
          requestId,
          message: elicitationRequest.message,
          schema: elicitationRequest.requestedSchema,
        };
        reject(error);
      }
    });
  }
  /**
   * Responds to a pending elicitation request
   */
  respondToElicitation(requestId, response) {
    const pending = this.pendingElicitations.get(requestId);
    if (!pending) {
      return false;
    }
    pending.resolve(response);
    this.pendingElicitations.delete(requestId);
    return true;
  }
  /**
   * Gets the pending elicitations map for external access
   */
  getPendingElicitations() {
    return this.pendingElicitations;
  }
  /**
   * Sets a callback to handle elicitation requests
   */
  setElicitationCallback(callback) {
    this.elicitationCallback = callback;
  }
  /**
   * Clears the elicitation callback
   */
  clearElicitationCallback() {
    this.elicitationCallback = void 0;
  }
};

// src/server/tests-router.ts
function createTestsRouter() {
  const tests = new Hono();
  tests.post("/run-all", async (c) => {
    const encoder = new TextEncoder();
    try {
      let createModel2 = function (model) {
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
          const clientManager = new MCPJamClientManager();
          for (const test of testsInput) {
            console.log(`\u{1F50D} Starting test: ${test.title}`);
            const calledTools = /* @__PURE__ */ new Set();
            const expectedSet = new Set(test.expectedTools || []);
            let serverConfigs = {};
            if (test.selectedServers && test.selectedServers.length > 0) {
              for (const name of test.selectedServers) {
                if (allServers[name]) serverConfigs[name] = allServers[name];
              }
            } else {
              serverConfigs = allServers;
            }
            console.log(
              `\u{1F4CB} Test ${test.title} using servers: ${Object.keys(serverConfigs).join(", ")}`,
            );
            if (Object.keys(serverConfigs).length === 0) {
              console.error(
                `\u274C No valid MCP server configs for test ${test.title}`,
              );
              continue;
            }
            try {
              console.log(
                `\u{1F50C} Connecting to servers for ${test.title}...`,
              );
              for (const [serverName, serverConfig] of Object.entries(
                serverConfigs,
              )) {
                console.log(`   Connecting to ${serverName}...`);
                await clientManager.connectToServer(serverName, serverConfig);
                console.log(`   \u2705 Connected to ${serverName}`);
              }
              console.log(
                `\u{1F916} Creating model ${test.model.provider}:${test.model.id}...`,
              );
              const model = createModel2(test.model);
              console.log(
                `\u{1F6E0}\uFE0F  Getting tools for ${test.title}...`,
              );
              const allTools = clientManager.getAvailableTools();
              const toolsByServer = {};
              for (const tool of allTools) {
                if (!toolsByServer[tool.serverId]) {
                  toolsByServer[tool.serverId] = {};
                }
                toolsByServer[tool.serverId][tool.name] = {
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  execute: async (params) => {
                    const result = await clientManager.executeToolDirect(
                      `${tool.serverId}:${tool.name}`,
                      params,
                    );
                    return result.result;
                  },
                };
              }
              console.log(
                `\u2705 Got ${allTools.length} total tools across ${Object.keys(toolsByServer).length} servers`,
              );
              console.log(
                `\u{1F50D} Servers:`,
                clientManager.mapIdsToOriginalNames(Object.keys(toolsByServer)),
              );
              const agent = new Agent({
                name: `TestAgent-${test.id}`,
                instructions:
                  "You are a helpful assistant with access to MCP tools",
                model,
              });
              console.log(
                `\u{1F4AC} Starting agent stream for ${test.title}...`,
              );
              const streamOptions = {
                maxSteps: 10,
                toolsets: toolsByServer,
                onStepFinish: ({ text, toolCalls, toolResults }) => {
                  if (toolCalls && toolCalls.length) {
                    console.log(
                      `\u{1F6E0}\uFE0F  Tool calls:`,
                      toolCalls.map((c2) => c2?.name || c2?.toolName),
                    );
                  }
                  (toolCalls || []).forEach((c2) => {
                    const toolName = c2?.name || c2?.toolName;
                    if (toolName) {
                      calledTools.add(toolName);
                    }
                  });
                },
              };
              const tAny = test;
              if (tAny?.advancedConfig?.toolChoice) {
                streamOptions.toolChoice = tAny.advancedConfig.toolChoice;
              }
              const stream = await agent.stream(
                [{ role: "user", content: test.prompt || "" }],
                streamOptions,
              );
              console.log(
                `\u{1F4C4} Draining text stream for ${test.title}...`,
              );
              for await (const _ of stream.textStream) {
              }
              console.log(`\u2705 Stream completed for ${test.title}`);
              const called = Array.from(calledTools);
              const missing = Array.from(expectedSet).filter(
                (t) => !calledTools.has(t),
              );
              const unexpected = called.filter((t) => !expectedSet.has(t));
              const passed = missing.length === 0 && unexpected.length === 0;
              console.log(
                `\u{1F4CA} Test ${test.title} result: ${passed ? "PASSED" : "FAILED"}`,
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
                  })}

`,
                ),
              );
            } catch (err) {
              console.error(`\u274C Test ${test.title} failed:`, err);
              failed = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "result",
                    testId: test.id,
                    passed: false,
                    error: err?.message,
                  })}

`,
                ),
              );
            } finally {
              console.log(
                `\u{1F50C} Disconnecting servers for ${test.title}...`,
              );
              for (const serverName of Object.keys(serverConfigs)) {
                try {
                  await clientManager.disconnectFromServer(serverName);
                  console.log(`   \u2705 Disconnected from ${serverName}`);
                } catch (disconnectErr) {
                  console.log(
                    `   \u26A0\uFE0F  Disconnect error from ${serverName}:`,
                    disconnectErr,
                  );
                }
              }
              console.log(`\u2705 Test ${test.title} cleanup complete`);
            }
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "run_complete",
                passed: !failed,
              })}

`,
            ),
          );
          controller.enqueue(
            encoder.encode(`data: [DONE]

`),
          );
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
        { success: false, error: err?.message || "Unknown error" },
        500,
      );
    }
  });
  return tests;
}

// src/runner/test-runner.ts
async function findAvailablePort(startPort = 3500) {
  return new Promise((resolve2, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const port = server.address()?.port;
      server.close(() => {
        resolve2(port || startPort);
      });
    });
    server.on("error", () => {
      resolve2(startPort);
    });
  });
}
async function runTests(tests, environment) {
  const startTime = Date.now();
  const app = new Hono2();
  app.route("/mcp/tests", createTestsRouter());
  const port = await findAvailablePort();
  const server = serve({
    fetch: app.fetch,
    port,
  });
  await new Promise((resolve2) => setTimeout(resolve2, 100));
  try {
    const backendTests = tests.map((test, index) => ({
      id: `test_${index}`,
      title: test.title,
      prompt: test.prompt,
      expectedTools: test.expectedTools,
      model: test.model,
      selectedServers: test.selectedServers,
    }));
    const backendServers = Object.fromEntries(
      Object.entries(environment.mcpServers).map(([name, config]) => [
        name,
        convertServerConfig(config),
      ]),
    );
    const payload = {
      tests: backendTests,
      allServers: backendServers,
      providerApiKeys: environment.providerApiKeys || {},
    };
    const response = await fetch(`http://localhost:${port}/mcp/tests/run-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(
        `Server error: ${response.status} ${response.statusText}`,
      );
    }
    const results = await processStreamingResults(response, tests);
    const duration = ((Date.now() - startTime) / 1e3).toFixed(1);
    return {
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      duration,
      results,
    };
  } finally {
    if (server && typeof server.close === "function") {
      server.close();
    }
  }
}
function convertServerConfig(config) {
  if ("command" in config) {
    return {
      command: config.command,
      args: config.args || [],
      env: config.env || {},
    };
  } else {
    return {
      url: config.url,
      requestInit: {
        headers: config.headers || {},
      },
      eventSourceInit: {
        headers: config.headers || {},
      },
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
              duration: 0,
              // We don't have individual timing from the stream
            };
            results.push(result);
            if (result.passed) {
              console.log(`\u2705 ${result.title}`);
              console.log(
                `   Called tools: ${result.calledTools.join(", ") || "none"}`,
              );
            } else {
              console.log(`\u274C ${result.title}`);
              if (result.error) {
                console.log(`   Error: ${result.error}`);
              } else {
                console.log(
                  `   Called tools: ${result.calledTools.join(", ") || "none"}`,
                );
                if (result.missingTools.length > 0) {
                  console.log(`   Missing: ${result.missingTools.join(", ")}`);
                }
                if (result.unexpectedTools.length > 0) {
                  console.log(
                    `   Unexpected: ${result.unexpectedTools.join(", ")}`,
                  );
                }
              }
            }
          } else if (event.type === "trace_step") {
          }
        } catch (e) {}
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
        resolveServerConfig(config),
      ]),
    ),
    providerApiKeys: env.providerApiKeys
      ? {
          anthropic: resolveTemplate(env.providerApiKeys.anthropic),
          openai: resolveTemplate(env.providerApiKeys.openai),
          deepseek: resolveTemplate(env.providerApiKeys.deepseek),
        }
      : void 0,
  };
}
function resolveServerConfig(config) {
  if ("command" in config) {
    return {
      ...config,
      env: config.env
        ? Object.fromEntries(
            Object.entries(config.env).map(([key, value]) => [
              key,
              resolveTemplate(value),
            ]),
          )
        : void 0,
    };
  } else {
    return {
      ...config,
      headers: config.headers
        ? Object.fromEntries(
            Object.entries(config.headers).map(([key, value]) => [
              key,
              resolveTemplate(value),
            ]),
          )
        : void 0,
    };
  }
}
function resolveTemplate(value) {
  if (!value) return value;
  const collapseWhitespace = (s) =>
    s.replace(/[\r\n]+/g, "").replace(/\s{2,}/g, "");
  return value.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const raw = process.env[envVar];
    const resolved = raw ? collapseWhitespace(raw) : raw;
    if (resolved === void 0) {
      console.warn(
        `\u26A0\uFE0F  Warning: Environment variable ${envVar} is not set`,
      );
      return match;
    }
    return resolved;
  });
}

// src/commands/evals.ts
var evalsCommand = new Command("evals");
evalsCommand
  .description("Run MCP evaluations")
  .command("run")
  .description("Run tests against MCP servers")
  .requiredOption("-t, --tests <file>", "Path to tests JSON file")
  .requiredOption("-e, --environment <file>", "Path to environment JSON file")
  .action(async (options) => {
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
      console.log(
        `
Results: ${results.passed} passed, ${results.failed} failed (${results.duration}s total)
`,
      );
      if (results.failed > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(
        "\u274C Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// src/index.ts
var program = new Command2();
program
  .name("mcpjam")
  .description("MCPJam CLI for programmatic MCP testing")
  .version("1.0.0");
program.addCommand(evalsCommand);
program.parse();
//# sourceMappingURL=index.js.map
