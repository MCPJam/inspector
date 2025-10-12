import { Hono } from "hono";
import fixPath from "fix-path";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import dotenv from "dotenv";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Import routes
import mcpRoutes from "./routes/mcp/index.js";
import { MCPClientManager } from "@/shared/mcp-client-manager";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createHonoApp() {
  // Load environment variables early so route handlers can read CONVEX_HTTP_URL
  const envFile =
    process.env.NODE_ENV === "production"
      ? ".env.production"
      : ".env.development";

  // Determine where to look for .env file:
  // 1. Electron packaged: use process.resourcesPath directly
  // 2. npm package: package root (two levels up from dist/server)
  // 3. Local dev: current working directory
  let envPath = envFile;

  if (process.env.IS_PACKAGED === "true" && process.resourcesPath) {
    // Electron packaged app - use process.resourcesPath directly
    envPath = join(process.resourcesPath, envFile);
  } else if (process.env.ELECTRON_APP === "true") {
    // Electron dev mode - already handled by src/main.ts setting env vars
    envPath = join(process.env.ELECTRON_RESOURCES_PATH || ".", envFile);
  } else {
    // npm package or local dev
    const packageRoot = resolve(__dirname, "..", "..");
    const packageEnvPath = join(packageRoot, envFile);
    if (existsSync(packageEnvPath)) {
      envPath = packageEnvPath;
    }
  }

  dotenv.config({ path: envPath });

  // Validate required env vars
  if (!process.env.CONVEX_HTTP_URL) {
    throw new Error(
      `CONVEX_HTTP_URL is required but not set. Tried loading from: ${envPath}\n` +
        `IS_PACKAGED=${process.env.IS_PACKAGED}, resourcesPath=${process.resourcesPath}\n` +
        `File exists: ${existsSync(envPath)}`,
    );
  }

  // Ensure PATH includes user shell paths so child processes (e.g., npx) can be found
  // This is crucial when launched from GUI apps (Electron) where PATH is minimal
  try {
    fixPath();
  } catch {}
  const app = new Hono();

  // Create the MCPJam client manager instance
  const mcpClientManager = new MCPClientManager();
  if (process.env.DEBUG_MCP_SELECTION === "1") {
    console.log("[mcpjam][boot] DEBUG_MCP_SELECTION enabled");
  }

  // Middleware to inject the client manager into context
  app.use("*", async (c, next) => {
    c.mcpClientManager = mcpClientManager;
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
