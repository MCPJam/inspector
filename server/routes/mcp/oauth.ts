import { Hono } from 'hono'

const oauth = new Hono()

// Proxy OAuth metadata requests to avoid CORS issues
oauth.get('/metadata/:serverUrl', async (c) => {
  const encodedServerUrl = c.req.param('serverUrl')
  
  if (!encodedServerUrl) {
    return c.json({ error: 'Missing server URL parameter' }, 400)
  }
  
  const decodedUrl = decodeURIComponent(encodedServerUrl)
  
  try {
    const metadataUrl = `${decodedUrl}/.well-known/oauth-authorization-server`
    console.log(`Fetching OAuth metadata from: ${metadataUrl}`)
    
    const response = await fetch(metadataUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MCP Inspector'
      }
    })
    
    if (!response.ok) {
      console.error(`OAuth metadata fetch failed: ${response.status} ${response.statusText}`)
      return c.json({ error: `Failed to fetch OAuth metadata: ${response.status}` }, 500)
    }
    
    const data = await response.json()
    console.log(`OAuth metadata fetched successfully for ${decodedUrl}`)
    return c.json(data)
  } catch (error) {
    console.error(`OAuth metadata request failed for ${decodedUrl}:`, error)
    return c.json({ 
      error: `OAuth metadata request failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, 500)
  }
})

// Server-side OAuth initiation endpoint  
oauth.post('/initiate', async (c) => {
  try {
    const { serverUrl, serverName, scopes } = await c.req.json()
    
    if (!serverUrl || !serverName) {
      return c.json({ error: 'Missing required parameters: serverUrl and serverName' }, 400)
    }
    
    console.log(`Initiating OAuth for ${serverName} at ${serverUrl}`)
    
    // Fetch OAuth metadata server-side
    const metadataUrl = `${serverUrl}/.well-known/oauth-authorization-server`
    const metadataResponse = await fetch(metadataUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MCP Inspector'
      }
    })
    
    if (!metadataResponse.ok) {
      return c.json({ 
        error: `Failed to fetch OAuth metadata: ${metadataResponse.status}` 
      }, 500)
    }
    
    const metadata = await metadataResponse.json()
    
    // Return the metadata and let client handle the rest
    return c.json({ 
      success: true, 
      metadata,
      serverUrl,
      serverName 
    })
    
  } catch (error) {
    console.error('OAuth initiation failed:', error)
    return c.json({ 
      error: `OAuth initiation failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, 500)
  }
})

// Handle OAuth callback
oauth.post('/callback', async (c) => {
  try {
    const body = await c.req.json()
    const { code, state, serverUrl } = body
    
    if (!code || !serverUrl) {
      return c.json({ error: 'Missing required OAuth parameters' }, 400)
    }
    
    // For now, just return success - the client will handle token exchange
    // In a full implementation, you might want to handle token exchange server-side
    return c.json({ success: true, code, serverUrl })
  } catch (error) {
    return c.json({ error: 'OAuth callback failed' }, 500)
  }
})

export default oauth