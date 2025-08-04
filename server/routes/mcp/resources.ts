import { Hono } from 'hono'
import { validateServerConfig, createMCPClient } from '../../utils/mcp-utils'
import { ContentfulStatusCode } from 'hono/utils/http-status'

const resources = new Hono()

// List resources endpoint
resources.post('/list', async (c) => {
  try {
    const { serverConfig } = await c.req.json()

    const validation = validateServerConfig(serverConfig)
    if (!validation.success) {
      return c.json({ success: false, error: validation.error!.message }, validation.error!.status as ContentfulStatusCode)
    }

    const client = createMCPClient(
      validation.config!,
      `resources-list-${Date.now()}`,
    )

    try {
      const resources = await client.resources.list()

      // Cleanup
      await client.disconnect()

      return c.json({ resources })
    } catch (error) {
      await client.disconnect()
      throw error
    }
  } catch (error) {
    console.error('Error fetching resources:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// Read resource endpoint
resources.post('/read', async (c) => {
  try {
    const { serverConfig, uri } = await c.req.json()

    const validation = validateServerConfig(serverConfig)
    if (!validation.success) {
      return c.json({ success: false, error: validation.error!.message }, validation.error!.status as ContentfulStatusCode)
    }

    if (!uri) {
      return c.json({
        success: false,
        error: 'Resource URI is required'
      }, 400)
    }

    const client = createMCPClient(
      validation.config!,
      `resources-read-${Date.now()}`,
    )

    try {
      const content = await client.resources.read('server', uri)

      // Cleanup
      await client.disconnect()

      return c.json({ content })
    } catch (error) {
      await client.disconnect()
      throw error
    }
  } catch (error) {
    console.error('Error reading resource:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

export default resources