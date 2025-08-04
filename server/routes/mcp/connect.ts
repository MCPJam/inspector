import { Hono } from 'hono'
import { validateServerConfig, createMCPClient } from '../../utils/mcp-utils'

const connect = new Hono()

connect.post('/', async (c) => {
  try {
    const { serverConfig } = await c.req.json()

    const validation = validateServerConfig(serverConfig)
    if (!validation.success) {
      const error = validation.error!
      return c.json(
        {
          success: false,
          error: error.message,
        },
        error.status,
      )
    }

    let client
    try {
      client = createMCPClient(validation.config!, `test-${Date.now()}`)
    } catch (error) {
      return c.json(
        {
          success: false,
          error: `Failed to create a MCP client. Please double check your server configuration: ${JSON.stringify(serverConfig)}`,
          details: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      )
    }

    try {
      await client.getTools()
      await client.disconnect()
      return c.json({
        success: true,
      })
    } catch (error) {
      return c.json(
        {
          success: false,
          error: `MCP configuration is invalid. Please double check your server configuration: ${JSON.stringify(serverConfig)}`,
          details: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      )
    }
  } catch (error) {
    return c.json(
      {
        success: false,
        error: "Failed to parse request body",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      400,
    )
  }
})

export default connect