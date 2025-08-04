import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

app.get('/simple', (c) => {
  console.log('Simple endpoint hit')
  return c.text('Hello from simple server!')
})

console.log('Starting simple server on port 9000')
serve({ fetch: app.fetch, port: 9000 })