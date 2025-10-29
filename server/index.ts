import "./sentry";
import * as Sentry from "@sentry/node";

import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import fixPath from "fix-path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
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
import { rpcLogBus } from "./services/rpc-log-bus";
import { interceptorStore } from "./services/interceptor-store";
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
            type: serverConfig.type || "stdio", // Default to stdio if not specified
            command: serverConfig.command,
            args: serverConfig.args || [],
            env: serverConfig.env || {},
            url: serverConfig.url, // For SSE/HTTP connections
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

const app = new Hono().onError((err, c) => {
  console.error("Unhandled error:", err);

  // Report all unhandled errors to Sentry (including HTTPExceptions)
  Sentry.captureException(err);

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

// Middleware
app.use("*", logger());
// Dynamic CORS origin based on PORT environment variable
const serverPort = process.env.PORT || "3001";
const corsOrigins = [
  `http://localhost:${serverPort}`,  // Backend server itself
  "http://localhost:5173",            // Vite dev server (npm run dev)
  "http://127.0.0.1:5173",            // Vite dev server with 127.0.0.1
  "http://localhost:8080",            // Electron dev mode (Vite dev server for Electron)
  "http://127.0.0.1:8080",            // Electron dev mode with 127.0.0.1
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

app.post("/sse/message", async (c) => {
  try {
    const url = new URL(c.req.url);
    const sessionId =
      url.searchParams.get("sessionId") || url.searchParams.get("sid") || "";
    if (!sessionId) {
      return c.json({ error: "Missing sessionId" }, 400);
    }
    const mapping = interceptorStore.getSessionMapping(sessionId);
    if (!mapping) {
      return c.json({ error: "Unknown sessionId" }, 404);
    }
    const entry = interceptorStore.get(mapping.interceptorId);
    if (!entry) {
      return c.json({ error: "Interceptor not found" }, 404);
    }

    // Read body as text (JSON-RPC envelope) and forward
    let bodyText = "";
    try {
      bodyText = await c.req.text();
    } catch {}
    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (
        [
          "connection",
          "keep-alive",
          "transfer-encoding",
          "upgrade",
          "proxy-authenticate",
          "proxy-authorization",
          "te",
          "trailer",
          "host",
          "content-length",
        ].includes(key)
      )
        return;
      headers.set(k, v);
    });
    if (entry.injectHeaders) {
      for (const [k, v] of Object.entries(entry.injectHeaders)) {
        const key = k.toLowerCase();
        if (
          [
            "connection",
            "keep-alive",
            "transfer-encoding",
            "upgrade",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "host",
            "content-length",
          ].includes(key)
        )
          continue;
        if (key === "authorization" && headers.has("authorization")) continue;
        headers.set(k, v);
      }
    }
    // Forward to upstream messages endpoint
    try {
      await fetch(
        new Request(mapping.url, { method: "POST", headers, body: bodyText }),
      );
    } catch {}
    // Per spec semantics, reply 202 regardless (response arrives via SSE)
    return c.body("Accepted", 202, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    });
  } catch (e: any) {
    return c.body(
      JSON.stringify({ error: e?.message || "Forward error" }),
      400,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
      },
    );
  }
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

// MCP OAuth callback handler
// This handles OAuth callbacks in external browsers during Electron MCP OAuth flows
app.get("/oauth/callback", (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  // Check if we're running in Electron mode
  const isElectron = process.env.ELECTRON_APP === "true";

  if (isElectron) {
    // In Electron, redirect to custom protocol so the app can handle it
    const protocolUrl = new URL("mcpjam://oauth/callback");
    if (code) protocolUrl.searchParams.set("code", code);
    if (state) protocolUrl.searchParams.set("state", state);
    if (error) protocolUrl.searchParams.set("error", error);

    // Serve HTML that redirects to custom protocol
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>OAuth Callback</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              text-align: center;
              padding: 2rem;
              background: white;
              border-radius: 8px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            .icon { font-size: 48px; margin-bottom: 1rem; }
            h1 { margin: 0 0 0.5rem 0; font-size: 24px; }
            p { color: #666; margin: 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">✓</div>
            <h1>Authentication Complete</h1>
            <p>Redirecting to MCPJam Inspector...</p>
          </div>
          <script>
            // Redirect to custom protocol - this will trigger Electron's open-url handler
            window.location.href = "${protocolUrl.toString()}";

            // Fallback: close window after 3 seconds if redirect doesn't work
            setTimeout(() => {
              window.close();
            }, 3000);
          </script>
        </body>
      </html>
    `);
  } else {
    // In web mode, serve the frontend which will handle the callback
    // The frontend routing will detect we're on /oauth/callback and process it
    const indexPath = join(__dirname, "../client/index.html");
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    }

    // Fallback if index.html not found (should not happen in production)
    console.error(`[OAuth Callback] index.html not found at ${indexPath}, redirecting to home`);
    return c.redirect(`/?oauth_code=${code || ""}&oauth_error=${error || ""}`);
  }
});

// Static file serving (for production)
if (process.env.NODE_ENV === "production") {
  // Serve public assets (logos, etc.) at root level
  app.use("/*.png", serveStatic({ root: "./public" }));
  app.use("/*.svg", serveStatic({ root: "./public" }));
  app.use("/*.jpg", serveStatic({ root: "./public" }));
  app.use("/*.jpeg", serveStatic({ root: "./public" }));
  app.use("/*.ico", serveStatic({ root: "./public" }));

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

const port = parseInt(process.env.PORT || "3001");

// Default to localhost unless explicitly running in production
const hostname = process.env.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1";
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
