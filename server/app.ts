import { Hono } from "hono";
import fixPath from "fix-path";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";

// Import routes
import mcpRoutes from "./routes/mcp/index.js";
import { MCPJamClientManager } from "./services/mcpjam-client-manager.js";
import path from "path";

export function createHonoApp() {
  // Ensure PATH includes user shell paths so child processes (e.g., npx) can be found
  // This is crucial when launched from GUI apps (Electron) where PATH is minimal
  try {
    fixPath();
  } catch {}
  const app = new Hono();

  // Create the MCPJam client manager instance
  const mcpJamClientManager = new MCPJamClientManager();

  // Middleware to inject the client manager into context
  app.use("*", async (c, next) => {
    c.mcpJamClientManager = mcpJamClientManager;
    await next();
  });

  // Middleware
  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: [
        "http://localhost:8080",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://localhost:3000",
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

  // Static hosting / dev redirect behavior
  const isElectron = process.env.ELECTRON_APP === "true";
  const isProduction = process.env.NODE_ENV === "production";
  const isPackaged = process.env.IS_PACKAGED === "true";

  if (isProduction || (isElectron && isPackaged)) {
    // Production (web) or Electron packaged build: serve files from bundled client
    let root = "./dist/client";
    if (isElectron && isPackaged) {
      root = path.resolve(process.env.ELECTRON_RESOURCES_PATH!, "client");
    }
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ path: `${root}/index.html` }));
  } else if (isElectron && !isPackaged) {
    // Electron development: redirect any front-end route to the renderer dev server
    const rendererDevUrl = "http://localhost:8080";
    app.get("/*", (c) => {
      const target = new URL(c.req.path, rendererDevUrl).toString();
      return c.redirect(target, 307);
    });
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
