import { NextRequest } from "next/server";
import {
  validateServerConfig,
  createMCPClient,
  createErrorResponse,
} from "@/lib/mcp-utils";
import type { Tool } from "@mastra/core/tools";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Store for pending elicitation requests
const pendingElicitations = new Map<
  string,
  {
    resolve: (response: any) => void;
    reject: (error: any) => void;
  }
>();

export async function POST(request: NextRequest) {
  let client: any = null;
  let encoder: TextEncoder | null = null;
  let streamController: ReadableStreamDefaultController | null = null;

  try {
    const { action, serverConfig, toolName, parameters, requestId, response } =
      await request.json();

    if (!action || !["list", "execute", "respond"].includes(action)) {
      return createErrorResponse(
        "Invalid action",
        "Action must be 'list', 'execute', or 'respond'",
      );
    }

    // Handle elicitation response
    if (action === "respond") {
      if (!requestId) {
        return createErrorResponse(
          "Missing requestId",
          "requestId is required for respond action",
        );
      }

      const pending = pendingElicitations.get(requestId);
      if (!pending) {
        return createErrorResponse(
          "Invalid requestId",
          "No pending elicitation found for this requestId",
        );
      }

      // Resolve the pending elicitation with user's response
      pending.resolve(response);
      pendingElicitations.delete(requestId);

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        streamController = controller;

        try {
          client = createMCPClient(
            validation.config!,
            `tools-${action}-${Date.now()}`,
          );

          if (action === "list") {
            // Stream tools list
            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "tools_loading",
                  message: "Fetching tools from server...",
                })}\n\n`,
              ),
            );

            const tools: Record<string, Tool> = await client.getTools();

            // Convert from Zod to JSON Schema
            const toolsWithJsonSchema: Record<string, any> = Object.fromEntries(
              Object.entries(tools).map(([toolName, tool]) => [
                toolName,
                {
                  ...tool,
                  inputSchema: zodToJsonSchema(
                    tool.inputSchema as unknown as z.ZodType<any>,
                  ),
                },
              ]),
            );

            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "tools_list",
                  tools: toolsWithJsonSchema,
                })}\n\n`,
              ),
            );
          } else if (action === "execute") {
            // Stream tool execution
            if (!toolName) {
              controller.enqueue(
                encoder!.encode(
                  `data: ${JSON.stringify({
                    type: "tool_error",
                    error: "Tool name is required for execution",
                  })}\n\n`,
                ),
              );
              return;
            }

            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "tool_executing",
                  toolName,
                  parameters: parameters || {},
                  message: "Executing tool...",
                })}\n\n`,
              ),
            );

            const tools = await client.getTools();
            const tool = tools[toolName];

            if (!tool) {
              controller.enqueue(
                encoder!.encode(
                  `data: ${JSON.stringify({
                    type: "tool_error",
                    error: `Tool '${toolName}' not found`,
                  })}\n\n`,
                ),
              );
              return;
            }

            const toolArgs =
              parameters && typeof parameters === "object" ? parameters : {};

            // Set up elicitation handler
            const elicitationHandler = async (elicitationRequest: any) => {
              const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

              // Stream elicitation request to client
              if (streamController && encoder) {
                streamController.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "elicitation_request",
                      requestId,
                      message: elicitationRequest.message,
                      schema: elicitationRequest.requestedSchema,
                      timestamp: new Date(),
                    })}\n\n`,
                  ),
                );
              }

              // Return a promise that will be resolved when user responds
              return new Promise((resolve, reject) => {
                pendingElicitations.set(requestId, { resolve, reject });

                // Set a timeout to clean up if no response
                setTimeout(() => {
                  if (pendingElicitations.has(requestId)) {
                    pendingElicitations.delete(requestId);
                    reject(new Error("Elicitation timeout"));
                  }
                }, 300000); // 5 minute timeout
              });
            };

            // Register elicitation handler with the client
            if (client.elicitation && client.elicitation.onRequest) {
              const serverName = "server"; // See createMCPClient() function. The name of the server is "server"
              client.elicitation.onRequest(serverName, elicitationHandler);
            }

            const result = await tool.execute({
              context: toolArgs,
            });

            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "tool_result",
                  toolName,
                  result,
                })}\n\n`,
              ),
            );

            // Stream elicitation completion if there were any
            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "elicitation_complete",
                  toolName,
                })}\n\n`,
              ),
            );
          }

          controller.enqueue(encoder!.encode(`data: [DONE]\n\n`));
        } catch (error) {
          console.error(`Error in tools ${action}:`, error);
          controller.enqueue(
            encoder!.encode(
              `data: ${JSON.stringify({
                type: "tool_error",
                error: error instanceof Error ? error.message : "Unknown error",
              })}\n\n`,
            ),
          );
        } finally {
          if (client) {
            try {
              await client.disconnect();
            } catch (cleanupError) {
              console.warn("Error cleaning up MCP client:", cleanupError);
            }
          }
          controller.close();
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
    console.error("Error in tools stream API:", error);

    // Clean up client on error
    if (client) {
      try {
        await client.disconnect();
      } catch (cleanupError) {
        console.warn("Error cleaning up MCP client after error:", cleanupError);
      }
    }

    return createErrorResponse(
      "Failed to process tools request",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
