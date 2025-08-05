import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import { join } from "path";

// Import routes
import mcpRoutes from "./routes/mcp/index";

const app = new Hono();

// Middleware
app.use("*", logger());
// Dynamic CORS origin based on PORT environment variable
const serverPort = process.env.PORT || "3001";
const corsOrigins = [
  `http://localhost:${serverPort}`,
  "http://localhost:3000", // Keep for development
  "http://localhost:3001", // Keep for development
];

app.use(
  "*",
  cors({
    origin: corsOrigins,
    credentials: true,
  })
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
  app.get("*", async (c) => {
    const path = c.req.path;
    // Don't intercept API routes
    if (path.startsWith("/api/")) {
      return c.notFound();
    }
    // Return index.html for SPA routes
    const indexPath = join(process.cwd(), "dist", "client", "index.html");
    const htmlContent = readFileSync(indexPath, "utf-8");
    return c.html(htmlContent);
  });
} else {
  // Development mode - just API
  app.get("/", (c) => {
    return c.json({
      message: "MCP Inspector API Server",
      environment: "development",
      frontend: `http://localhost:${serverPort}`,
    });
  });
}

const port = parseInt(process.env.PORT || "3001");

console.log(`🚀 MCP Inspector Server starting on port ${port}`);
console.log(`📡 API available at: http://localhost:${port}/api`);
if (process.env.NODE_ENV !== "production") {
  console.log(`🎨 Frontend dev server: http://localhost:${serverPort}`);
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
