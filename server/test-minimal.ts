import { serve } from "@hono/node-server";
import { Hono } from "hono";

console.log("🧪 Starting minimal test server...");

const app = new Hono();

app.get("/test", (c) => {
  console.log("✅ Test endpoint called");
  return c.json({
    message: "Test endpoint works",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (c) => {
  console.log("✅ Health endpoint called");
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

const port = 8003;
console.log(`🚀 Minimal server starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`📡 Test server running at: http://localhost:${port}`);
console.log(`🔍 Test with: curl http://localhost:${port}/test`);
