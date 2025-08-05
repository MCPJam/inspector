import { serve } from '@hono/node-server'
import { createHonoApp } from './app.js'

// Create the Hono app using the shared module
const app = createHonoApp()

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