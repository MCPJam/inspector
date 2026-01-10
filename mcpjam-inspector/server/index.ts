import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import fixPath from "fix-path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { logger as appLogger } from "./utils/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { MCPClientManager } from "@/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Utility function to create a boxed console output
function logBox(content: string, title?: string) {
  const lines = content.split("\n");
  const maxLength = Math.max(...lines.map((line) => line.length));
  const width = maxLength + 4;

  console.log("┌" + "─".repeat(width) + "┐");
  if (title) {
    const titlePadding = Math.floor((width - title.length - 2) / 2);
    console.log(
      "│" +
        " ".repeat(titlePadding) +
        title +
        " ".repeat(width - title.length - titlePadding) +
        "│",
    );
    console.log("├" + "─".repeat(width) + "┤");
  }

  lines.forEach((line) => {
    const padding = width - line.length - 2;
    console.log("│ " + line + " ".repeat(padding) + " │");
  });

  console.log("└" + "─".repeat(width) + "┘");
}

// Import routes and services
import mcpRoutes from "./routes/mcp/index";
import appsRoutes from "./routes/apps/index";
import { rpcLogBus } from "./services/rpc-log-bus";
import { tunnelManager } from "./services/tunnel-manager";
import { SERVER_PORT, SERVER_HOSTNAME, CORS_ORIGINS } from "./config";
import "./types/hono"; // Type extensions

// Utility function to extract MCP server config from environment variables
function getMCPConfigFromEnv() {
  // Global options that apply to all modes
  const initialTab = process.env.MCP_INITIAL_TAB || null;

  // First check if we have a full config file
  const configData = process.env.MCP_CONFIG_DATA;
  if (configData) {
    try {
      const config = JSON.parse(configData);
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        // Transform the config to match client expectations
        const servers = Object.entries(config.mcpServers).map(
          ([name, serverConfig]: [string, any]) => {
            // Determine type: if url is present it's HTTP, otherwise stdio
            const hasUrl = !!serverConfig.url;
            const type = serverConfig.type || (hasUrl ? "http" : "stdio");

            return {
              name,
              type,
              command: serverConfig.command,
              args: serverConfig.args || [],
              env: serverConfig.env || {},
              url: serverConfig.url, // For SSE/HTTP connections
              headers: serverConfig.headers, // Custom headers for HTTP
              useOAuth: serverConfig.useOAuth, // Trigger OAuth flow
            };
          },
        );

        // Check for auto-connect server filter
        const autoConnectServer = process.env.MCP_AUTO_CONNECT_SERVER;

        return {
          servers,
          autoConnectServer: autoConnectServer || null,
          initialTab,
        };
      }
    } catch (error) {
      appLogger.error("Failed to parse MCP_CONFIG_DATA:", error);
    }
  }

  // Fall back to legacy single server mode
  const command = process.env.MCP_SERVER_COMMAND;
  if (!command) {
    // No server config, but still return global options if set
    if (initialTab) {
      return {
        servers: [],
        initialTab,
      };
    }
    return null;
  }

  const argsString = process.env.MCP_SERVER_ARGS;
  const args = argsString ? JSON.parse(argsString) : [];

  return {
    servers: [
      {
        command,
        args,
        name: "CLI Server", // Default name for CLI-provided servers
        env: {},
      },
    ],
    initialTab,
  };
}

// Ensure PATH is initialized from the user's shell so spawned processes can find binaries (e.g., npx)
try {
  fixPath();
} catch {}

const app = new Hono().onError((err, c) => {
  appLogger.error("Unhandled error:", err);

  // Return appropriate response
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  return c.json({ error: "Internal server error" }, 500);
});

// Load environment variables early so route handlers can read CONVEX_HTTP_URL
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";

// Determine where to look for .env file:
// 1. Electron: Resources folder
// 2. npm package: package root (two levels up from dist/server)
// 3. Local dev: current working directory
let envPath = envFile;
if (
  process.env.ELECTRON_APP === "true" &&
  process.env.ELECTRON_RESOURCES_PATH
) {
  envPath = join(process.env.ELECTRON_RESOURCES_PATH, envFile);
} else {
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
    "CONVEX_HTTP_URL is required but not set. Please set it via environment variable or .env file.",
  );
}

// Initialize centralized MCPJam Client Manager and wire RPC logging to SSE bus
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
  },
);
// Middleware to inject client manager into context
app.use("*", async (c, next) => {
  c.mcpClientManager = mcpClientManager;
  await next();
});

// Middleware - only enable HTTP request logging in dev mode or when --verbose is passed
const enableHttpLogs =
  process.env.NODE_ENV !== "production" || process.env.VERBOSE_LOGS === "true";
if (enableHttpLogs) {
  app.use("*", logger());
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

// Fallback for clients that post to "/sse/message" instead of the rewritten proxy messages URL.
// We resolve the upstream messages endpoint via sessionId and forward with any injected auth.
// CORS preflight
app.options("/sse/message", (c) => {
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, Accept-Language",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers",
  });
});

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API endpoint to get MCP CLI config (for development mode)
app.get("/api/mcp-cli-config", (c) => {
  const mcpConfig = getMCPConfigFromEnv();
  return c.json({ config: mcpConfig });
});

// Static file serving (for production)
if (process.env.NODE_ENV === "production") {
  // Serve static assets (JS, CSS, images, etc.) - includes public assets bundled by Vite
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
    let htmlContent = readFileSync(indexPath, "utf-8");

    // Inject MCP server config if provided via CLI
    const mcpConfig = getMCPConfigFromEnv();
    if (mcpConfig) {
      const configScript = `<script>window.MCP_CLI_CONFIG = ${JSON.stringify(mcpConfig)};</script>`;
      htmlContent = htmlContent.replace("</head>", `${configScript}</head>`);
    }

    return c.html(htmlContent);
  });
} else {
  // Development mode - just API
  app.get("/", (c) => {
    return c.json({
      message: "MCPJam API Server",
      environment: "development",
      frontend: `http://localhost:${SERVER_PORT}`,
    });
  });
}

// Use server configuration
const displayPort = process.env.ENVIRONMENT === "dev" ? 5173 : SERVER_PORT;
logBox(`http://${SERVER_HOSTNAME}:${displayPort}`, "🎵 MCPJam");

// Start the Hono server
const server = serve({
  fetch: app.fetch,
  port: SERVER_PORT,
  hostname: "127.0.0.1",
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await tunnelManager.closeAll();
  server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await tunnelManager.closeAll();
  server.close();
  process.exit(0);
});

export default app;
