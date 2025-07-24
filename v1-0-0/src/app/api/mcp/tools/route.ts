import { NextRequest } from "next/server";
import {
  validateServerConfig,
  createMCPClient,
  createErrorResponse,
} from "@/lib/mcp-utils";
import type { Tool } from "@mastra/core/tools";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Server-side logger - logs to console and could be extended to log to external services
const logger = {
  info: (message: string, data?: unknown) => {
    console.log(`[INFO] [ToolsAPI] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  debug: (message: string, data?: unknown) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DEBUG] [ToolsAPI] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  },
  warn: (message: string, data?: unknown) => {
    console.warn(`[WARN] [ToolsAPI] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  error: (message: string, data?: unknown, error?: Error) => {
    console.error(`[ERROR] [ToolsAPI] ${message}`, data ? JSON.stringify(data, null, 2) : '', error?.stack || '');
  },
  trace: (message: string, data?: unknown) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[TRACE] [ToolsAPI] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }
};

// Store for pending elicitation requests
const pendingElicitations = new Map<
  string,
  {
    resolve: (response: any) => void;
    reject: (error: any) => void;
  }
>();

export async function POST(request: NextRequest) {
  const requestStartTime = Date.now();
  let client: any = null;
  let encoder: TextEncoder | null = null;
  let streamController: ReadableStreamDefaultController | null = null;
  let action: string | undefined;
  let toolName: string | undefined;

  try {
    const requestData = await request.json();
    action = requestData.action;
    toolName = requestData.toolName;
    const { serverConfig, parameters, requestId, response } = requestData;

    logger.info('Tools API request received', { 
      action,
      toolName,
      hasParameters: !!parameters,
      requestId 
    });

    if (!action || !["list", "execute", "respond"].includes(action)) {
      logger.error('Invalid action provided', { action });
      return createErrorResponse(
        "Invalid action",
        "Action must be 'list', 'execute', or 'respond'",
      );
    }

    // Handle elicitation response
    if (action === "respond") {
      logger.debug('Processing elicitation response', { requestId, hasResponse: !!response });
      
      if (!requestId) {
        logger.error('Elicitation response missing requestId');
        return createErrorResponse(
          "Missing requestId",
          "requestId is required for respond action",
        );
      }

      const pending = pendingElicitations.get(requestId);
      if (!pending) {
        logger.warn('No pending elicitation found for requestId', { requestId });
        return createErrorResponse(
          "Invalid requestId",
          "No pending elicitation found for this requestId",
        );
      }

      logger.info('Resolving elicitation request', { 
        requestId,
        responseAction: response?.action 
      });

      // Resolve the pending elicitation with user's response
      pending.resolve(response);
      pendingElicitations.delete(requestId);

      const responseTime = Date.now() - requestStartTime;
      logger.debug('Elicitation response processed successfully', { 
        requestId,
        responseTime 
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      logger.error('Server config validation failed', { 
        action,
        toolName,
        error: validation.error 
      });
      return validation.error!;
    }

    logger.debug('Server config validated successfully', { 
      action,
      serverType: 'command' in validation.config! ? 'stdio' : 'http' 
    });

    encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        streamController = controller;

        try {
          logger.debug('Creating MCP client', { action, toolName });
          const clientId = `tools-${action}-${Date.now()}`;
          client = createMCPClient(validation.config!, clientId);
          logger.debug('MCP client created successfully', { clientId });

          if (action === "list") {
            logger.info('Starting tools list operation');
            
            // Stream tools list
            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "tools_loading",
                  message: "Fetching tools from server...",
                })}\n\n`,
              ),
            );

            logger.debug('Requesting tools from MCP client');
            const toolsFetchStart = Date.now();
            const tools: Record<string, Tool> = await client.getTools();
            const toolsFetchDuration = Date.now() - toolsFetchStart;
            const toolCount = Object.keys(tools).length;

            logger.info('Tools fetched from MCP client', { 
              toolCount,
              fetchDuration: toolsFetchDuration 
            });

            // Convert from Zod to JSON Schema
            logger.debug('Converting Zod schemas to JSON schemas');
            const schemaConvertStart = Date.now();
            const toolsWithJsonSchema: Record<string, any> = Object.fromEntries(
              Object.entries(tools).map(([toolName, tool]) => {
                logger.trace('Converting schema for tool', { toolName });
                return [
                  toolName,
                  {
                    ...tool,
                    inputSchema: zodToJsonSchema(
                      tool.inputSchema as unknown as z.ZodType<any>,
                    ),
                  },
                ];
              }),
            );
            const schemaConvertDuration = Date.now() - schemaConvertStart;

            logger.debug('Schema conversion completed', { 
              toolCount,
              convertDuration: schemaConvertDuration 
            });

            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "tools_list",
                  tools: toolsWithJsonSchema,
                })}\n\n`,
              ),
            );

            logger.info('Tools list sent to client', { toolCount });
          } else if (action === "execute") {
            logger.info('Starting tool execution operation', { toolName });
            
            // Stream tool execution
            if (!toolName) {
              logger.error('Tool execution failed: no tool name provided');
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

            logger.debug('Fetching tools to validate tool exists', { toolName });
            const tools = await client.getTools();
            const tool = tools[toolName];

            if (!tool) {
              logger.error('Tool not found', { 
                toolName,
                availableTools: Object.keys(tools) 
              });
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

            logger.debug('Tool found, preparing execution', { 
              toolName,
              hasParameters: !!parameters 
            });

            const toolArgs =
              parameters && typeof parameters === "object" ? parameters : {};

            logger.debug('Tool arguments prepared', { 
              toolName,
              argCount: Object.keys(toolArgs).length,
              args: toolArgs 
            });

            // Set up elicitation handler
            const elicitationHandler = async (elicitationRequest: any) => {
              const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

              logger.info('Elicitation request received from tool', { 
                toolName,
                requestId,
                message: elicitationRequest.message 
              });

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
                
                logger.debug('Elicitation request sent to client', { 
                  toolName,
                  requestId 
                });
              }

              // Return a promise that will be resolved when user responds
              return new Promise((resolve, reject) => {
                pendingElicitations.set(requestId, { resolve, reject });
                logger.debug('Elicitation pending, waiting for user response', { 
                  toolName,
                  requestId 
                });

                // Set a timeout to clean up if no response
                setTimeout(() => {
                  if (pendingElicitations.has(requestId)) {
                    pendingElicitations.delete(requestId);
                    logger.warn('Elicitation request timed out', { 
                      toolName,
                      requestId 
                    });
                    reject(new Error("Elicitation timeout"));
                  }
                }, 300000); // 5 minute timeout
              });
            };

            // Register elicitation handler with the client
            if (client.elicitation && client.elicitation.onRequest) {
              const serverName = "server"; // See createMCPClient() function. The name of the server is "server"
              logger.debug('Registering elicitation handler', { toolName, serverName });
              client.elicitation.onRequest(serverName, elicitationHandler);
            } else {
              logger.debug('No elicitation support available', { toolName });
            }

            logger.info('Executing tool', { toolName, argCount: Object.keys(toolArgs).length });
            const executionStart = Date.now();
            
            const result = await tool.execute({
              context: toolArgs,
            });
            
            const executionDuration = Date.now() - executionStart;
            logger.info('Tool execution completed', { 
              toolName,
              executionDuration,
              hasResult: !!result 
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

            logger.debug('Tool result sent to client', { toolName });

            // Stream elicitation completion if there were any
            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: "elicitation_complete",
                  toolName,
                })}\n\n`,
              ),
            );

            logger.debug('Elicitation completion sent to client', { toolName });
          }

          const totalDuration = Date.now() - requestStartTime;
          logger.info('Tools operation completed successfully', { 
            action,
            toolName,
            totalDuration 
          });
          controller.enqueue(encoder!.encode(`data: [DONE]\n\n`));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          logger.error('Error in tools operation', { 
            action,
            toolName,
            error: errorMsg 
          }, error instanceof Error ? error : undefined);
          
          controller.enqueue(
            encoder!.encode(
              `data: ${JSON.stringify({
                type: "tool_error",
                error: errorMsg,
              })}\n\n`,
            ),
          );
        } finally {
          if (client) {
            try {
              logger.debug('Disconnecting MCP client', { action, toolName });
              await client.disconnect();
              logger.debug('MCP client disconnected successfully', { action, toolName });
            } catch (cleanupError) {
              logger.warn('Error cleaning up MCP client', { 
                action,
                toolName,
                error: cleanupError 
              });
            }
          }
          const totalDuration = Date.now() - requestStartTime;
          logger.debug('Stream controller closed', { 
            action,
            toolName,
            totalDuration 
          });
          controller.close();
        }
      },
    });

    const responseDuration = Date.now() - requestStartTime;
    logger.debug('Streaming response ready', { 
      action,
      toolName,
      responseDuration 
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
    const requestDuration = Date.now() - requestStartTime;
    
    logger.error('Error in tools stream API', { 
      action,
      toolName,
      error: errorMsg,
      requestDuration 
    }, error instanceof Error ? error : undefined);

    // Clean up client on error
    if (client) {
      try {
        logger.debug('Cleaning up MCP client after error', { action, toolName });
        await client.disconnect();
      } catch (cleanupError) {
        logger.warn('Error cleaning up MCP client after error', { 
          action,
          toolName,
          cleanupError 
        });
      }
    }

    return createErrorResponse(
      "Failed to process tools request",
      errorMsg,
    );
  }
}
