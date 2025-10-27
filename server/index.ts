import "./sentry";
import * as Sentry from "@sentry/node";

import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import fixPath from "fix-path";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { MCPClientManager } from "@/sdk";
import { randomBytes, timingSafeEqual } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

const sessionToken = randomBytes(32).toString("hex");
const authDisabled = !!process.env.DANGEROUSLY_OMIT_AUTH;

const clientPort = process.env.ENVIRONMENT === "dev" ? "3000" : "6274";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  allowedOrigins.push(`http://localhost:${clientPort}`);
  allowedOrigins.push(`http://127.0.0.1:${clientPort}`);
}

const originValidationMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && !allowedOrigins.includes(origin)) {
    return c.json(
      {
        error: "Forbidden - invalid origin",
        message:
          "Request blocked to prevent DNS rebinding attacks. Configure allowed origins via the ALLOWED_ORIGINS environment variable.",
      },
      403,
    );
  }
  await next();
};

const unauthorizedResponse = (c: Parameters<MiddlewareHandler>[0]) =>
  c.json(
    {
      error: "Unauthorized",
      message:
        "Authentication required. Use the session token shown in the console when starting the server.",
    },
    401,
  );

const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (authDisabled || c.req.method === "OPTIONS") {
    await next();
    return;
  }

  const authHeader = c.req.header("authorization");
  console.log("authHeader", authHeader);
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return unauthorizedResponse(c);
  }

  const providedToken = authHeader.slice("Bearer ".length);
  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(sessionToken);

  if (providedBuffer.length !== expectedBuffer.length) {
    return unauthorizedResponse(c);
  }

  try {
    if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
      return unauthorizedResponse(c);
    }
  } catch {
    return unauthorizedResponse(c);
  }

  await next();
};

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

app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "Accept",
      "Accept-Language",
    ],
    exposeHeaders: ["mcp-session-id"],
    credentials: true,
  }),
);

app.use("/api/*", originValidationMiddleware);
app.use("/api/*", authMiddleware);
app.use("/sse/*", originValidationMiddleware);
app.use("/sse/*", authMiddleware);
app.use("/sse/message", originValidationMiddleware);
app.use("/sse/message", authMiddleware);

// API Routes
app.route("/api/mcp", mcpRoutes);

// Fallback for clients that post to "/sse/message" instead of the rewritten proxy messages URL.
// We resolve the upstream messages endpoint via sessionId and forward with any injected auth.
// CORS preflight
app.options("/sse/message", (c) => {
  const originHeader = c.req.header("origin");
  const fallbackOrigin = allowedOrigins[0] || `http://127.0.0.1:${clientPort}`;
  const allowedOrigin =
    originHeader && allowedOrigins.includes(originHeader)
      ? originHeader
      : fallbackOrigin;
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": allowedOrigin,
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

const port = Number.parseInt(process.env.PORT || "3001", 10);
const host = process.env.HOST || "127.0.0.1";

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
      frontend: `http://localhost:${port}`,
    });
  });
}

const server = serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

console.log(`⚙️ Proxy server listening on ${host}:${port}`);

if (!authDisabled) {
  console.log(`🔑 Session token: ${sessionToken}`);
  const clientUrl = `http://localhost:${clientPort}/?MCP_PROXY_AUTH_TOKEN=${sessionToken}`;
  console.log(`\n🔗 Open inspector with token pre-filled:\n   ${clientUrl}\n`);
} else {
  console.log(
    "⚠️  WARNING: Authentication is disabled. This is not recommended.",
  );
}

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
