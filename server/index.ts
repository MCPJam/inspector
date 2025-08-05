import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from '@hono/node-server/serve-static'

// Import routes
import mcpRoutes from './routes/mcp/index'

const app = new Hono()

// Middleware
app.use('*', logger())
// Global CORS settings
app.use('*', cors({
  origin: ['http://localhost:8080', 'http://localhost:3000'],
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposeHeaders: ['Content-Length', 'Content-Type']
}))

// API Routes
app.route('/api/mcp', mcpRoutes)

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Static file serving (for production)
if (process.env.NODE_ENV === 'production') {
  // Serve static assets (JS, CSS, images, etc.)
  app.use('/*', serveStatic({ root: './dist/client' }))
  
  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (c) => {
    const path = c.req.path
    // Don't intercept API routes
    if (path.startsWith('/api/')) {
      return c.notFound()
    }
    // Specifically handle OAuth callback routes to ensure they work with SPA
    if (path.startsWith('/oauth/callback')) {
      console.log('OAuth callback detected, serving index.html for SPA routing')
    }
    // Return index.html for SPA routes
    return serveStatic({ path: './dist/client/index.html' })(c)
  })
} else {
  // Development mode - API and SPA routes support
  app.get('/', (c) => {
    return c.json({ 
      message: 'MCP Inspector API Server', 
      environment: 'development',
      frontend: 'http://localhost:3000'
    })
  })
  
  // Support SPA routing for OAuth in development mode
  app.get('/oauth/*', (c) => {
    console.log(`Development mode: Detected OAuth route ${c.req.path}, redirecting to frontend`)
    return c.redirect('http://localhost:3000' + c.req.path + c.req.query)
  })
}

const port = parseInt(process.env.PORT || '3001')

console.log(`🚀 MCP Inspector Server starting on port ${port}`)
console.log(`📡 API available at: http://localhost:${port}/api`)
if (process.env.NODE_ENV !== 'production') {
  console.log(`🎨 Frontend dev server: http://localhost:8080`)
}

// Graceful shutdown handling
const server = serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0'  // Bind to all interfaces for Docker
})

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⚠️  Received SIGINT, shutting down gracefully...')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n⚠️  Received SIGTERM, shutting down gracefully...')
  process.exit(0)
})

export default app