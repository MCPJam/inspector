import { Hono } from "hono";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TextEncoder } from "util";
import "../../types/hono"; // Type extensions
import MCPJamClientManager from "../../services/mcpjam-client-manager";

const tools = new Hono();

// Store for pending elicitation requests
const pendingElicitations = new Map<
  string,
  {
    resolve: (response: any) => void;
    reject: (error: any) => void;
  }
>();

tools.post("/", async (c) => {
  let action: string | undefined;
  let toolName: string | undefined;

  try {
    const requestData = await c.req.json();
    action = requestData.action;
    toolName = requestData.toolName;
    const { serverConfig, parameters, requestId, response } = requestData;

    if (!action || !["list", "execute", "respond"].includes(action)) {
      return c.json(
        {
          success: false,
          error: "Action must be 'list', 'execute', or 'respond'",
        },
        400,
      );
    }

    // Handle elicitation response
    if (action === "respond") {
      if (!requestId) {
        return c.json(
          {
            success: false,
            error: "requestId is required for respond action",
          },
          400,
        );
      }

      const mcpJamClientManager = c.get("mcpJamClientManager");
      const success = mcpJamClientManager.respondToElicitation(
        requestId,
        response,
      );

      if (!success) {
        // Also check local pendingElicitations for backward compatibility
        const pending = pendingElicitations.get(requestId);
        if (pending) {
          pending.resolve(response);
          pendingElicitations.delete(requestId);
          return c.json({ success: true });
        }

        return c.json(
          {
            success: false,
            error: "No pending elicitation found for this requestId",
          },
          404,
        );
      }

      return c.json({ success: true });
    }

    // Use centralized MCPJam Agent
    const encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          if (!serverConfig) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "tool_error", error: "serverConfig is required" })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            controller.close();
            return;
          }

          const mcpJamClientManager = c.get("mcpJamClientManager");
          // Use server name from config or default key
          const serverId =
            (serverConfig as any).name || (serverConfig as any).id || "server";
          await mcpJamClientManager.connectToServer(serverId, serverConfig);

          // Set up elicitation callback for streaming context
          mcpJamClientManager.setElicitationCallback(async (request) => {
            const { requestId, message, schema } = request;

            // Stream elicitation request to client
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "elicitation_request",
                  requestId,
                  message,
                  schema,
                  toolName: toolName || "unknown",
                  timestamp: new Date(),
                })}\n\n`,
              ),
            );

            // Return a promise that will be resolved by the respond endpoint
            return new Promise((resolve, reject) => {
              pendingElicitations.set(requestId, {
                resolve: (response: any) => {
                  resolve(response);
                  pendingElicitations.delete(requestId);
                },
                reject: (error: any) => {
                  reject(error);
                  pendingElicitations.delete(requestId);
                },
              });

              // Set timeout
              setTimeout(() => {
                if (pendingElicitations.has(requestId)) {
                  pendingElicitations.delete(requestId);
                  reject(new Error("Elicitation timeout"));
                }
              }, 300000); // 5 minutes
            });
          });

          if (action === "list") {
            // Use existing connection through MCPJam Agent to get un-prefixed tools
            try {
              const flattenedTools =
                await mcpJamClientManager.getToolsetsForServer(serverId);

              // Convert to the expected format with JSON schema conversion
              const toolsWithJsonSchema: Record<string, any> = {};
              for (const [name, tool] of Object.entries(flattenedTools)) {
                let inputSchema = (tool as any).inputSchema;
                try {
                  // If original schemas are Zod, convert to JSON Schema. Otherwise pass through.
                  inputSchema = zodToJsonSchema(inputSchema as z.ZodType<any>);
                } catch {
                  // ignore conversion errors and use existing schema shape
                }
                toolsWithJsonSchema[name] = {
                  name,
                  description: (tool as any).description,
                  inputSchema,
                  outputSchema: (tool as any).outputSchema,
                };
              }

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "tools_list", tools: toolsWithJsonSchema })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              controller.close();
              return;
            } catch (err) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "tool_error", error: err instanceof Error ? err.message : String(err) })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              controller.close();
              return;
            }
          }

          if (action === "execute") {
            if (!toolName) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "tool_error", error: "Tool name is required for execution" })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              controller.close();
              return;
            }

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "tool_executing", toolName, parameters: parameters || {}, message: "Executing tool..." })}\n\n`,
              ),
            );

            // Execute tool using centralized client manager
            const exec = await mcpJamClientManager.executeToolDirect(
              toolName,
              parameters || {},
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "tool_result", toolName, result: exec.result })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "elicitation_complete", toolName })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            controller.close();
            return;
          }
        } catch (err) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "tool_error", error: err instanceof Error ? err.message : String(err) })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        } finally {
          // Clear the elicitation callback
          if (c.get("mcpJamClientManager")) {
            c.get("mcpJamClientManager").clearElicitationCallback();
          }
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
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    return c.json(
      {
        success: false,
        error: errorMsg,
      },
      500,
    );
  }
});

export default tools;
