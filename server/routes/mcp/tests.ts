import { Hono } from "hono";
import { MastraMCPServerDefinition, MCPClient } from "@mastra/mcp";
import type { ModelDefinition } from "../../../shared/types";
import {
  validateMultipleServerConfigs,
  createMCPClientWithMultipleConnections,
} from "../../utils/mcp-utils";

const tests = new Hono();

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
    const overrideBackendHttpUrl = body?.backendHttpUrl as string | undefined;
    const allServers = (body?.allServers || {}) as Record<
      string,
      MastraMCPServerDefinition
    >;
    const maxConcurrency: number = Math.max(
      1,
      Math.min(8, body?.concurrency ?? 5),
    );

    if (!Array.isArray(testsInput) || testsInput.length === 0) {
      return c.json({ success: false, error: "No tests provided" }, 400);
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
              const tools = await client.getTools();

              // Debug: log a sample tool to understand its structure
              const sampleToolName = Object.keys(tools)[0];
              if (sampleToolName) {
                console.log(`[${sampleToolName}] Tool structure:`, {
                  tool: tools[sampleToolName],
                  inputSchema: (tools[sampleToolName] as any)?.inputSchema,
                  inputSchemaJSON: (tools[sampleToolName] as any)?.inputSchema?.toJSON?.()
                });
              }

              // Build tool schemas for backend agent
              const toolsSchemas = Object.entries(tools).map(([name, t]) => {
                const tool = t as any;
                let inputSchema = {};

                // Try to extract schema from Zod object
                if (tool?.inputSchema) {
                  // First try toJSON()
                  const jsonSchema = tool.inputSchema.toJSON?.();
                  if (jsonSchema && typeof jsonSchema === 'object') {
                    inputSchema = jsonSchema;
                  } else {
                    // Fallback: try to extract from Zod _def
                    const zodDef = tool.inputSchema._def;
                    if (zodDef?.typeName === 'ZodObject') {
                      // For ZodObject, create a simple object schema
                      inputSchema = {
                        type: 'object',
                        additionalProperties: false,
                        properties: {},
                        required: []
                      };

                      // Try to extract properties if available
                      if (zodDef.shape && typeof zodDef.shape === 'function') {
                        try {
                          const shape = zodDef.shape();
                          const properties: any = {};
                          const required: string[] = [];

                          for (const [key, value] of Object.entries(shape)) {
                            properties[key] = { type: 'string' }; // Simple fallback
                            if ((value as any)?._def?.typeName !== 'ZodOptional') {
                              required.push(key);
                            }
                          }

                          inputSchema = {
                            type: 'object',
                            additionalProperties: false,
                            properties,
                            required
                          };
                        } catch (e) {
                          // Keep default empty object schema
                        }
                      }
                    }
                  }
                }

                console.log(`[${name}] Extracted schema:`, { inputSchema });

                return {
                  toolName: name,
                  inputSchema,
                };
              });

              const runId = `${Date.now()}-${test.id}`;
              const backendUrl = (() => {
                if (overrideBackendHttpUrl) return overrideBackendHttpUrl.replace(/\/$/, "");
                const explicit = process.env.CONVEX_HTTP_URL;
                if (explicit) return explicit.replace(/\/$/, "");
                const convexUrl = process.env.VITE_CONVEX_URL || process.env.CONVEX_URL;
                if (convexUrl) {
                  try {
                    const u = new URL(convexUrl);
                    const host = u.host.replace('.convex.cloud', '.convex.site');
                    return `${u.protocol}//${host}`;
                  } catch {}
                }
                return "http://localhost:3210";
              })();

              // Emit debug info
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "debug", testId: test.id, backendUrl })}\n\n`,
                ),
              );
              console.log("[tests] Using backend URL:", backendUrl);

              // Start one-step on backend
              const startRes = await fetch(`${backendUrl}/evals/agent/start`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  runId,
                  model: test.model,
                  toolsSchemas,
                  messages: [
                    { role: "system", content: "You are a helpful assistant with access to MCP tools." },
                    { role: "user", content: test.prompt || "" },
                  ],
                }),
              });
              if (!startRes.ok) {
                const errText = await startRes.text().catch(() => "");
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "result", testId: test.id, passed: false, error: `Backend start failed: ${startRes.status} ${errText}` })}\n\n`,
                  ),
                );
                throw new Error(`Backend start failed: ${startRes.status} ${errText}`);
              }
              const startJson: any = await startRes.json();
              if (!startJson.ok) throw new Error((startJson as any).error || "start failed");

              let state: any = startJson;
              // Loop until assistant_text
              while (state.kind === "tool_call") {
                const name = state.toolName as string;
                const args = state.args || {};
                console.log(`[${name}] Calling tool with args:`, { rawArgs: state.args, finalArgs: args });

                // Debug: check if the tool exists and its execute function
                const tool = (tools as any)[name];
                console.log(`[${name}] Tool info:`, { exists: !!tool, hasExecute: !!tool?.execute, toolKeys: tool ? Object.keys(tool) : [] });

                try {
                  const normalizeToolName = (toolName: string) => {
                    for (const id of Object.keys(finalServers)) {
                      const prefix = `${id}_`;
                      if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
                    }
                    return toolName;
                  };
                  const result = await tool?.execute({ context: args });
                  calledTools.add(name);
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "trace_step", testId: test.id, step: ++step, text: "Executed tool", toolCalls: [normalizeToolName(name)], toolResults: [result] })}\n\n`,
                    ),
                  );
                  const stepRes = await fetch(`${backendUrl}/evals/agent/step`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      runId,
                      model: test.model,
                      toolsSchemas,
                      messages: state.steps?.[state.steps.length - 1]?.messages || [
                        { role: "system", content: "You are a helpful assistant with access to MCP tools." },
                        { role: "user", content: test.prompt || "" },
                      ],
                      toolResultMessage: {
                        role: "tool",
                        content: [{
                          type: "tool-result",
                          toolCallId: state.toolCallId,
                          toolName: name,
                          output: result
                        }],
                      },
                    }),
                  });
                  const stepJson: any = await stepRes.json();
                  if (!stepJson.ok) {
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "result", testId: test.id, passed: false, error: (stepJson as any).error || "step failed" })}\n\n`,
                      ),
                    );
                    throw new Error((stepJson as any).error || "step failed");
                  }
                  state = stepJson as any;
                } catch (err) {
                  console.log(`[${name}] Error calling tool:`, { error: err instanceof Error ? err.message : String(err), toolArgs: args });
                  throw new Error(`Tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              const normalizeToolName = (toolName: string) => {
                for (const id of Object.keys(finalServers)) {
                  const prefix = `${id}_`;
                  if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
                }
                return toolName;
              };

              const called = Array.from(calledTools).map((t) => normalizeToolName(t));
              const missing = Array.from(expectedSet).filter(
                (t) => !called.includes(t),
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
