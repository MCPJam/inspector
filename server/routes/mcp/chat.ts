import { Hono } from 'hono'
import {
  validateMultipleServerConfigs,
  createMCPClientWithMultipleConnections,
} from '../../utils/mcp-utils'
import { Agent } from '@mastra/core/agent'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOllama } from 'ollama-ai-provider'
import { ChatMessage, ModelDefinition } from '../../../shared/types'
import { MCPClient } from '@mastra/mcp'
import { ContentfulStatusCode } from 'hono/utils/http-status'

const chat = new Hono()

// Store for pending elicitation requests
const pendingElicitations = new Map<
  string,
  {
    resolve: (response: any) => void
    reject: (error: any) => void
  }
>()

chat.post('/', async (c) => {
  let client: MCPClient | null = null
  try {
    const requestData = await c.req.json()
    const {
      serverConfigs,
      model,
      apiKey,
      systemPrompt,
      messages,
      ollamaBaseUrl,
      action,
      requestId,
      response,
    }: {
      serverConfigs?: Record<string, any>
      model?: ModelDefinition
      apiKey?: string
      systemPrompt?: string
      messages?: ChatMessage[]
      ollamaBaseUrl?: string
      action?: string
      requestId?: string
      response?: any
    } = requestData

    // Handle elicitation response
    if (action === 'elicitation_response') {
      if (!requestId) {
        return c.json({
          success: false,
          error: 'requestId is required for elicitation_response action'
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

    if (!model || !model.id || !apiKey || !messages) {
      return c.json({
        success: false,
        error: 'model (with id), apiKey, and messages are required'
      }, 400)
    }

    if (serverConfigs && Object.keys(serverConfigs).length > 0) {
      const validation = validateMultipleServerConfigs(serverConfigs)
      if (!validation.success) {
        return c.json({ 
          success: false, 
          error: validation.error!.message,
          details: validation.errors 
        }, validation.error!.status as ContentfulStatusCode)
      }

      client = createMCPClientWithMultipleConnections(validation.validConfigs!)
    } else {
      client = new MCPClient({
        id: `chat-${Date.now()}`,
        servers: {},
      })
    }

    // Get tools and ensure client is connected
    const tools = await client.getTools()

    const llmModel = getLlmModel(model, apiKey, ollamaBaseUrl)

    // Create a custom event emitter for streaming tool events
    let toolCallId = 0
    let streamController: ReadableStreamDefaultController | null = null
    let encoder: TextEncoder | null = null

    // Set up elicitation handler
    const elicitationHandler = async (elicitationRequest: any) => {
      const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

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
      return new Promise<{
        action: 'accept' | 'decline' | 'cancel'
        content?: { [x: string]: unknown }
        _meta?: { [x: string]: unknown }
      }>((resolve, reject) => {
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

    // Register elicitation handler with the client for all servers
    if (client.elicitation && client.elicitation.onRequest && serverConfigs) {
      // Register elicitation handler for each server
      for (const serverName of Object.keys(serverConfigs)) {
        // Normalize server name to match MCPClient's internal naming
        const normalizedName = serverName
          .toLowerCase()
          .replace(/[\s\-]+/g, '_')
          .replace(/[^a-z0-9_]/g, '')
        client.elicitation.onRequest(normalizedName, elicitationHandler)
      }
    }

    // Wrap tools to capture tool calls and results
    const originalTools = tools && Object.keys(tools).length > 0 ? tools : {}
    const wrappedTools: Record<string, any> = {}

    for (const [name, tool] of Object.entries(originalTools)) {
      wrappedTools[name] = {
        ...(tool as any),
        execute: async (params: any) => {
          const currentToolCallId = ++toolCallId

          // Stream tool call event immediately
          if (streamController && encoder) {
            streamController.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'tool_call',
                  toolCall: {
                    id: currentToolCallId,
                    name,
                    parameters: params,
                    timestamp: new Date(),
                    status: 'executing',
                  },
                })}\n\n`,
              ),
            )
          }

          try {
            const result = await (tool as any).execute(params)

            // Stream tool result event immediately
            if (streamController && encoder) {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'tool_result',
                    toolResult: {
                      id: currentToolCallId,
                      toolCallId: currentToolCallId,
                      result,
                      timestamp: new Date(),
                    },
                  })}\n\n`,
                ),
              )
            }

            return result
          } catch (error) {
            // Stream tool error event immediately
            if (streamController && encoder) {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'tool_result',
                    toolResult: {
                      id: currentToolCallId,
                      toolCallId: currentToolCallId,
                      error:
                        error instanceof Error ? error.message : String(error),
                      timestamp: new Date(),
                    },
                  })}\n\n`,
                ),
              )
            }
            throw error
          }
        },
      }
    }

    const agent = new Agent({
      name: 'MCP Chat Agent',
      instructions:
        systemPrompt || 'You are a helpful assistant with access to MCP tools.',
      model: llmModel,
      tools: Object.keys(wrappedTools).length > 0 ? wrappedTools : undefined,
    })

    const formattedMessages = messages.map((msg: ChatMessage) => ({
      role: msg.role,
      content: msg.content,
    }))

    // Start streaming
    const stream = await agent.stream(formattedMessages, {
      maxSteps: 10, // Allow up to 10 steps for tool usage
    })

    encoder = new TextEncoder()
    const readableStream = new ReadableStream({
      async start(controller) {
        streamController = controller

        try {
          let hasContent = false
          for await (const chunk of stream.textStream) {
            if (chunk && chunk.trim()) {
              hasContent = true
              controller.enqueue(
                encoder!.encode(
                  `data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`,
                ),
              )
            }
          }

          // If no content was streamed, send a fallback message
          if (!hasContent) {
            controller.enqueue(
              encoder!.encode(
                `data: ${JSON.stringify({ type: 'text', content: "I apologize, but I couldn't generate a response. Please try again." })}\n\n`,
              ),
            )
          }

          // Stream elicitation completion if there were any
          controller.enqueue(
            encoder!.encode(
              `data: ${JSON.stringify({
                type: 'elicitation_complete',
              })}\n\n`,
            ),
          )

          controller.enqueue(encoder!.encode(`data: [DONE]\n\n`))
        } catch (error) {
          console.error('Streaming error:', error)
          controller.enqueue(
            encoder!.encode(
              `data: ${JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Unknown error',
              })}\n\n`,
            ),
          )
        } finally {
          if (client) {
            try {
              await client.disconnect()
            } catch (cleanupError) {
              console.warn(
                'Error cleaning up MCP client after streaming:',
                cleanupError,
              )
            }
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
    console.error('Error in chat API:', error)

    // Clean up client on error
    if (client) {
      try {
        await client.disconnect()
      } catch (cleanupError) {
        console.warn('Error cleaning up MCP client after error:', cleanupError)
      }
    }

    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

const getLlmModel = (
  modelDefinition: ModelDefinition,
  apiKey: string,
  ollamaBaseUrl?: string,
) => {
  if (!modelDefinition || !modelDefinition.id || !modelDefinition.provider) {
    throw new Error(
      `Invalid model definition: ${JSON.stringify(modelDefinition)}`,
    )
  }

  switch (modelDefinition.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelDefinition.id)
    case 'openai':
      return createOpenAI({ apiKey })(modelDefinition.id)
    case 'ollama':
      const baseUrl = ollamaBaseUrl || 'http://localhost:11434'
      return createOllama({
        baseURL: `${baseUrl}/api`, // Configurable Ollama API endpoint
      })(modelDefinition.id, {
        simulateStreaming: true, // Enable streaming for Ollama models
      })
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      )
  }
}

export default chat