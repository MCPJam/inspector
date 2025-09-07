import { serve } from "@hono/node-server";
import fixPath from "fix-path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import { join } from "path";

// ANSI color codes for console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

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
import { MCPJamClientManager } from "./services/mcpjam-client-manager";
import "./types/hono"; // Type extensions

// Utility function to extract MCP server config from environment variables
function getMCPConfigFromEnv() {
  // First check if we have a full config file
  const configData = process.env.MCP_CONFIG_DATA;
  if (configData) {
    try {
      const config = JSON.parse(configData);
      console.log("Parsed config data:", config);
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        // Transform the config to match client expectations
        const servers = Object.entries(config.mcpServers).map(
          ([name, serverConfig]: [string, any]) => ({
            name,
            command: serverConfig.command,
            args: serverConfig.args || [],
            env: serverConfig.env || {},
          }),
        );
        console.log("Transformed servers:", servers);

        // Check for auto-connect server filter
        const autoConnectServer = process.env.MCP_AUTO_CONNECT_SERVER;
        console.log(
          "Auto-connect server filter:",
          autoConnectServer || "none (connect to all)",
        );

        return {
          servers,
          autoConnectServer: autoConnectServer || null,
        };
      }
    } catch (error) {
      console.error("Failed to parse MCP_CONFIG_DATA:", error);
    }
  }

  // Fall back to legacy single server mode
  const command = process.env.MCP_SERVER_COMMAND;
  if (!command) {
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
  };
}

// Ensure PATH is initialized from the user's shell so spawned processes can find binaries (e.g., npx)
try {
  fixPath();
} catch {}

const app = new Hono();

// Initialize centralized MCPJam Client Manager
const mcpJamClientManager = new MCPJamClientManager();

// Middleware to inject client manager into context
app.use("*", async (c, next) => {
  c.mcpJamClientManager = mcpJamClientManager;
  await next();
});

// Middleware
app.use("*", logger());
// Dynamic CORS origin based on PORT environment variable
const serverPort = process.env.PORT || "3000";
const corsOrigins = [
  `http://localhost:${serverPort}`,
  "http://localhost:3000", // Keep for development
];

app.use(
  "*",
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);

// API Routes
app.route("/api/mcp", mcpRoutes);

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
      frontend: `http://localhost:${serverPort}`,
    });
  });
}

const port = parseInt(process.env.PORT || "3000");

// Default to localhost unless explicitly running in production
const hostname =
  process.env.NODE_ENV === "production" ? "127.0.0.1" : "localhost";
logBox(`http://${hostname}:${port}`, "🚀 Inspector Launched");

// Graceful shutdown handling
const server = serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0", // Bind to all interfaces for Docker
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down gracefully...");
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Shutting down gracefully...");
  server.close();
  process.exit(0);
});

export default app;
