import { Hono } from 'hono'
import { validateServerConfig, createMCPClient } from '../../utils/mcp-utils'
import type { Tool } from '@mastra/core/tools'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { ContentfulStatusCode } from 'hono/utils/http-status'

const tools = new Hono()

// Store for pending elicitation requests
const pendingElicitations = new Map<
  string,
  {
    resolve: (response: any) => void
    reject: (error: any) => void
  }
>()

tools.post('/', async (c) => {
  let client: any = null
  let encoder: TextEncoder | null = null
  let streamController: ReadableStreamDefaultController | null = null
  let action: string | undefined
  let toolName: string | undefined

  try {
    const requestData = await c.req.json()
    action = requestData.action
    toolName = requestData.toolName
    const { serverConfig, parameters, requestId, response } = requestData

    if (!action || !['list', 'execute', 'respond'].includes(action)) {
      return c.json({
        success: false,
        error: 'Action must be \'list\', \'execute\', or \'respond\''
      }, 400)
    }

    // Handle elicitation response
    if (action === 'respond') {
      if (!requestId) {
        return c.json({
          success: false,
          error: 'requestId is required for respond action'
        }, 400)
      }

      const pending = pendingElicitations.get(requestId)
      if (!pending) {
        return c.json({
          success: false,
          error: 'No pending elicitation found for this requestId'
        }, 404)
      }

      // Resolve the pending elicitation with user's response
      pending.resolve(response)
      pendingElicitations.delete(requestId)

      return c.json({ success: true })
    }

    const validation = validateServerConfig(serverConfig)
    if (!validation.success) {
      return c.json({ success: false, error: validation.error!.message }, validation.error!.status as ContentfulStatusCode)
    }

    encoder = new TextEncoder()
    const readableStream = new ReadableStream({
      async start(controller) {
        streamController = controller

        try {
          const clientId = `tools-${action}-${Date.now()}`
          client = createMCPClient(validation.config!, clientId)

          if (action === 'list') {
            // Stream tools list
            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: 'tools_loading',
                  message: 'Fetching tools from server...',
                })}\n\n`,
              ),
            )

            const tools: Record<string, Tool> = await client.getTools()

            // Convert from Zod to JSON Schema
            const toolsWithJsonSchema: Record<string, any> = Object.fromEntries(
              Object.entries(tools).map(([toolName, tool]) => {
                return [
                  toolName,
                  {
                    ...tool,
                    inputSchema: zodToJsonSchema(
                      tool.inputSchema as unknown as z.ZodType<any>,
                    ),
                  },
                ]
              }),
            )

            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: 'tools_list',
                  tools: toolsWithJsonSchema,
                })}\n\n`,
              ),
            )
          } else if (action === 'execute') {
            // Stream tool execution
            if (!toolName) {
              controller.enqueue(
                encoder!.encode(
                  `data: ${JSON.stringify({
                    type: 'tool_error',
                    error: 'Tool name is required for execution',
                  })}\n\n`,
                ),
              )
              return
            }

            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: 'tool_executing',
                  toolName,
                  parameters: parameters || {},
                  message: 'Executing tool...',
                })}\n\n`,
              ),
            )

            const tools = await client.getTools()
            const tool = tools[toolName]

            if (!tool) {
              controller.enqueue(
                encoder!.encode(
                  `data: ${JSON.stringify({
                    type: 'tool_error',
                    error: `Tool '${toolName}' not found`,
                  })}\n\n`,
                ),
              )
              return
            }

            const toolArgs =
              parameters && typeof parameters === 'object' ? parameters : {}

            // Set up elicitation handler
            const elicitationHandler = async (elicitationRequest: any) => {
              const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

              // Stream elicitation request to client
              if (streamController && encoder) {
                streamController.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: 'elicitation_request',
                      requestId,
                      message: elicitationRequest.message,
                      schema: elicitationRequest.requestedSchema,
                      timestamp: new Date(),
                    })}\n\n`,
                  ),
                )
              }

              // Return a promise that will be resolved when user responds
              return new Promise((resolve, reject) => {
                pendingElicitations.set(requestId, { resolve, reject })

                // Set a timeout to clean up if no response
                setTimeout(() => {
                  if (pendingElicitations.has(requestId)) {
                    pendingElicitations.delete(requestId)
                    reject(new Error('Elicitation timeout'))
                  }
                }, 300000) // 5 minute timeout
              })
            }

            // Register elicitation handler with the client
            if (client.elicitation && client.elicitation.onRequest) {
              const serverName = 'server' // See createMCPClient() function. The name of the server is "server"
              client.elicitation.onRequest(serverName, elicitationHandler)
            }

            const result = await tool.execute({
              context: toolArgs,
            })

            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: 'tool_result',
                  toolName,
                  result,
                })}\n\n`,
              ),
            )

            // Stream elicitation completion if there were any
            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({
                  type: 'elicitation_complete',
                  toolName,
                })}\n\n`,
              ),
            )
          }

          controller.enqueue(encoder!.encode(`data: [DONE]\n\n`))
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : 'Unknown error'

          controller.enqueue(
            encoder!.encode(
              `data: ${JSON.stringify({
                type: 'tool_error',
                error: errorMsg,
              })}\n\n`,
            ),
          )
        } finally {
          if (client) {
            await client.disconnect()
          }
          controller.close()
        }
      },
    })

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'

    // Clean up client on error
    if (client) {
      try {
        await client.disconnect()
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }

    return c.json({
      success: false,
      error: errorMsg
    }, 500)
  }
})

export default tools