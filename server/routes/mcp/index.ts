import { Hono } from 'hono'
import connect from './connect'
import tools from './tools'
import resources from './resources'
import prompts from './prompts'

const mcp = new Hono()

// Health check
mcp.get('/health', (c) => {
  return c.json({ 
    service: 'MCP API',
    status: 'ready',
    timestamp: new Date().toISOString()
  })
})

// Chat endpoint placeholder
mcp.post('/chat', (c) => {
  return c.json({ 
    message: 'Chat endpoint - will be implemented in Phase 3',
    status: 'placeholder'
  })
})

// Connect endpoint - REAL IMPLEMENTATION
mcp.route('/connect', connect)

// Tools endpoint - REAL IMPLEMENTATION
mcp.route('/tools', tools)

// Resources endpoints - REAL IMPLEMENTATION
mcp.route('/resources', resources)

// Prompts endpoints - REAL IMPLEMENTATION
mcp.route('/prompts', prompts)

export default mcp