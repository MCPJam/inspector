import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";

// Import routes
import mcpRoutes from "./routes/mcp/index";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "http://localhost:3001"],
    credentials: true,
  }),
);

// API Routes
app.route("/api/mcp", mcpRoutes);

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Static file serving (for production)
if (process.env.NODE_ENV === "production") {
  // Serve static assets (JS, CSS, images, etc.)
  app.use("/*", serveStatic({ root: "./dist/client" }));

  // SPA fallback - serve index.html for all non-API routes
  app.get("*", (c) => {
    const path = c.req.path;
    // Don't intercept API routes
    if (path.startsWith("/api/")) {
      return c.notFound();
    }
    // Return index.html for SPA routes
    return serveStatic({ path: "./dist/client/index.html" })(c);
  });
} else {
  // Development mode - just API
  app.get("/", (c) => {
    return c.json({
      message: "MCP Inspector API Server",
      environment: "development",
      frontend: "http://localhost:3000",
    });
  });
}

const port = parseInt(process.env.PORT || "3001");

console.log(`🚀 MCP Inspector Server starting on port ${port}`);
console.log(`📡 API available at: http://localhost:${port}/api`);
if (process.env.NODE_ENV !== "production") {
  console.log(`🎨 Frontend dev server: http://localhost:3000`);
}

// Graceful shutdown handling
const server = serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0", // Bind to all interfaces for Docker
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n⚠️  Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n⚠️  Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

export default app;
