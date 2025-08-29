import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";

// Import routes
import mcpRoutes from "./routes/mcp/index.js";
import path from "path";

export function createHonoApp() {
  const app = new Hono();

  // Middleware
  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: [
        "http://localhost:8080",
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:3000",
      ],
      credentials: true,
    }),
  );

  // API Routes
  app.route("/api/mcp", mcpRoutes);

  // Health check
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Static file serving (for production OR when running in Electron)
  const isElectron = process.env.ELECTRON_APP === "true";
  const isProduction = process.env.NODE_ENV === "production";
  const isPackaged = process.env.IS_PACKAGED === "true";

  if (isProduction || isElectron) {
    let root = "./dist/client";
    if (isElectron && isPackaged) {
      // Electron packaged app
      root = path.resolve(process.env.ELECTRON_RESOURCES_PATH!, "client");
    }

    // Serve static assets (JS, CSS, images, etc.)
    app.use("/*", serveStatic({ root }));

    // SPA fallback - serve index.html for all non-API routes
    app.get("/*", serveStatic({ path: `${root}/index.html` }));
  } else {
    // Development mode - just API
    app.get("/", (c) => {
      return c.json({
        message: "MCPJam API Server",
        environment: "development",
        frontend: "http://localhost:8080",
      });
    });
  }

  return app;
}
