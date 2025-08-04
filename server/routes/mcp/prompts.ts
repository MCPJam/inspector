import { Hono } from 'hono'
import { validateServerConfig, createMCPClient } from '../../utils/mcp-utils'
import { ContentfulStatusCode } from 'hono/utils/http-status'

const prompts = new Hono()

// List prompts endpoint
prompts.post('/list', async (c) => {
  try {
    const { serverConfig } = await c.req.json()

    const validation = validateServerConfig(serverConfig)
    if (!validation.success) {
      return c.json({ success: false, error: validation.error!.message }, validation.error!.status as ContentfulStatusCode)
    }

    const client = createMCPClient(
      validation.config!,
      `prompts-list-${Date.now()}`,
    )

    try {
      const prompts = await client.prompts.list()

      // Cleanup
      await client.disconnect()

      return c.json({ prompts })
    } catch (error) {
      await client.disconnect()
      throw error
    }
  } catch (error) {
    console.error('Error fetching prompts:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// Get prompt endpoint
prompts.post('/get', async (c) => {
  try {
    const { serverConfig, name, args } = await c.req.json()

    const validation = validateServerConfig(serverConfig)
    if (!validation.success) {
      return c.json({ success: false, error: validation.error!.message }, validation.error!.status as ContentfulStatusCode)
    }

    if (!name) {
      return c.json({
        success: false,
        error: 'Prompt name is required'
      }, 400)
    }

    const client = createMCPClient(
      validation.config!,
      `prompts-get-${Date.now()}`,
    )

    try {
      const content = await client.prompts.get({
        serverName: 'server',
        name,
        args: args || {},
      })

      // Cleanup
      await client.disconnect()

      return c.json({ content })
    } catch (error) {
      await client.disconnect()
      throw error
    }
  } catch (error) {
    console.error('Error getting prompt:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

export default prompts