import { Hono } from "hono";
import fixPath from "fix-path";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { logger as appLogger } from "./utils/logger.js";
import { serveStatic } from "@hono/node-server/serve-static";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Import routes
import mcpRoutes from "./routes/mcp/index.js";
import appsRoutes from "./routes/apps/index.js";
import { MCPClientManager } from "@/sdk";
import { initElicitationCallback } from "./routes/mcp/elicitation.js";
import { rpcLogBus } from "./services/rpc-log-bus.js";
import { progressStore } from "./services/progress-store.js";
import { CORS_ORIGINS, HOSTED_MODE, ALLOWED_HOSTS } from "./config.js";
import path from "path";

// Security imports
import {
  generateSessionToken,
  getSessionToken,
} from "./services/session-token.js";
import { isAllowedHost } from "./utils/localhost-check.js";
import {
  sessionAuthMiddleware,
  scrubTokenFromUrl,
} from "./middleware/session-auth.js";
import { originValidationMiddleware } from "./middleware/origin-validation.js";
import { securityHeadersMiddleware } from "./middleware/security-headers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createHonoApp() {
  // Load environment variables early so route handlers can read CONVEX_HTTP_URL
  const envFile =
    process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";

  // Determine where to look for .env file:
  // 1. Electron packaged: use process.resourcesPath directly
  // 2. npm package: package root (two levels up from dist/server)
  // 3. Local dev: current working directory
  let envPath = envFile;

  if (process.env.IS_PACKAGED === "true" && (process as any).resourcesPath) {
    // Electron packaged app - use process.resourcesPath directly
    envPath = join((process as any).resourcesPath, envFile);
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
        `IS_PACKAGED=${process.env.IS_PACKAGED}, resourcesPath=${(process as any).resourcesPath}\n` +
        `File exists: ${existsSync(envPath)}`,
    );
  }

  // Ensure PATH includes user shell paths so child processes (e.g., npx) can be found
  // This is crucial when launched from GUI apps (Electron) where PATH is minimal
  try {
    fixPath();
  } catch {}

  // Generate session token for API authentication
  generateSessionToken();
  const app = new Hono();

  // Create the MCPJam client manager instance and wire RPC logging to SSE bus
  const mcpClientManager = new MCPClientManager(
    {},
    {
      rpcLogger: ({ direction, message, serverId }) => {
        rpcLogBus.publish({
          serverId,
          direction,
          timestamp: new Date().toISOString(),
          message,
        });
      },
      progressHandler: ({
        serverId,
        progressToken,
        progress,
        total,
        message,
      }) => {
        // Store progress for UI access using the real progressToken from the notification
        progressStore.publish({
          serverId,
          progressToken,
          progress,
          total,
          message,
          timestamp: new Date().toISOString(),
        });
      },
    },
  );

  // Initialize elicitation callback immediately so tasks/result calls work
  // without needing to hit the elicitation endpoints first
  initElicitationCallback(mcpClientManager);

  if (process.env.DEBUG_MCP_SELECTION === "1") {
    appLogger.debug("[mcpjam][boot] DEBUG_MCP_SELECTION enabled");
  }

  // Middleware to inject the client manager into context
  app.use("*", async (c, next) => {
    c.mcpClientManager = mcpClientManager;
    await next();
  });

  // ===== SECURITY MIDDLEWARE STACK =====
  // Order matters: headers -> origin validation -> session auth

  // 1. Security headers (always applied)
  app.use("*", securityHeadersMiddleware);

  // 2. Origin validation (blocks CSRF/DNS rebinding)
  app.use("*", originValidationMiddleware);

  // 3. Session authentication (blocks unauthorized API requests)
  app.use("*", sessionAuthMiddleware);

  // ===== END SECURITY MIDDLEWARE =====

  // Middleware - only enable HTTP request logging in dev mode or when --verbose is passed
  const enableHttpLogs =
    process.env.NODE_ENV !== "production" ||
    process.env.VERBOSE_LOGS === "true";
  if (enableHttpLogs) {
    // Use custom print function to scrub session tokens from logged URLs
    app.use(
      "*",
      logger((message) => {
        appLogger.info(scrubTokenFromUrl(message));
      }),
    );
  }
  app.use(
    "*",
    cors({
      origin: CORS_ORIGINS,
      credentials: true,
    }),
  );

  // API Routes
  app.route("/api/apps", appsRoutes);
  app.route("/api/mcp", mcpRoutes);

  // Health check
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Session token endpoint (for dev mode where HTML isn't served by this server)
  // Token is only served to localhost or allowed hosts (in hosted mode)
  app.get("/api/session-token", (c) => {
    const host = c.req.header("Host");

    if (!isAllowedHost(host, ALLOWED_HOSTS, HOSTED_MODE)) {
      appLogger.warn(
        `[Security] Token request denied - Host not allowed: ${host}`,
      );
      return c.json({ error: "Token only available via allowed hosts" }, 403);
    }

    return c.json({ token: getSessionToken() });
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

    // Serve static assets (JS, CSS, images) - no token injection needed
    app.use("/assets/*", serveStatic({ root }));

    // Serve all static files from client root (images, svgs, etc.)
    // This handles files like /mcp_jam_light.png, /favicon.ico, etc.
    app.use("/*", serveStatic({ root }));

    // For HTML pages, inject the session token (only for localhost requests)
    app.get("/*", (c) => {
      const reqPath = c.req.path;

      // Don't intercept API routes
      if (reqPath.startsWith("/api/")) {
        return c.notFound();
      }

      try {
        const indexPath = path.join(root, "index.html");
        let html = readFileSync(indexPath, "utf-8");

        // SECURITY: Only inject token for localhost or allowed hosts (in hosted mode)
        // This prevents token leakage when bound to 0.0.0.0
        const host = c.req.header("Host");

        if (isAllowedHost(host, ALLOWED_HOSTS, HOSTED_MODE)) {
          const token = getSessionToken();
          const tokenScript = `<script>window.__MCP_SESSION_TOKEN__="${token}";</script>`;
          html = html.replace("</head>", `${tokenScript}</head>`);
        } else {
          // Host not allowed - no token (security measure)
          appLogger.warn(
            `[Security] Token not injected - Host not allowed: ${host}`,
          );
          const warningScript = `<script>console.error("MCPJam: Access via allowed host required for full functionality");</script>`;
          html = html.replace("</head>", `${warningScript}</head>`);
        }

        return c.html(html);
      } catch (error) {
        appLogger.error("Error serving index.html:", error);
        return c.text("Internal Server Error", 500);
      }
    });
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
