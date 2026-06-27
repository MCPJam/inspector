import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import fixPath from "fix-path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { logger as appLogger } from "./utils/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  getInspectorClientRuntimeConfigScript,
  loadInspectorEnv,
  warnOnConvexDevMisconfiguration,
} from "./env";
import { INSPECTOR_MCP_RETRY_POLICY } from "./utils/mcp-retry-policy";

// Security imports
import {
  generateSessionToken,
  getSessionToken,
} from "./services/session-token";
import { inspectorCommandBus } from "./services/inspector-command-bus";
import {
  mayServeSessionToken,
  mayServeGuestBootstrap,
} from "./utils/localhost-check";
import { getActiveTunnelDomains } from "./services/tunnel-registry";
import {
  appendGuestSessionSetCookie,
  buildGuestBootstrapScript,
  mintGuestSessionForDocument,
} from "./routes/web/guest-session-shared";
import {
  sessionAuthMiddleware,
  scrubTokenFromUrl,
} from "./middleware/session-auth";
import { originValidationMiddleware } from "./middleware/origin-validation";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { inAppBrowserMiddleware } from "./middleware/in-app-browser";
import { startGuestAuthProvisioningInBackground } from "./utils/convex-guest-auth-sync";
import { startLocalBrowserRenderingSetupInBackground } from "./utils/browser-rendering-setup";

import { getSystemLogger } from "./utils/request-logger";
import { requestLogContextMiddleware } from "./middleware/request-log-context";
import { getInspectorFrontendUrl } from "./utils/inspector-frontend-url";
import { createComputerTerminalWsHandler } from "./routes/web/computer-terminal";
import { registerSelfFetch } from "./utils/self-app";

const sysLogger = getSystemLogger("process");

// Handle unhandled promise rejections gracefully (Node.js v24+ throws by default)
// This prevents the server from crashing when MCP connections are closed while
// requests are pending - the SDK rejects pending promises on connection close
process.on("unhandledRejection", (reason, _promise) => {
  const isMcpConnectionClosed =
    reason instanceof Error &&
    (reason.message.includes("Connection closed") ||
      reason.name === "McpError");

  if (isMcpConnectionClosed) {
    sysLogger.event("mcp.connection.closed_with_pending_requests", {
      errorCode: "connection_closed",
    });
    return;
  }

  sysLogger.event(
    "process.unhandled_rejection",
    { errorCode: reason instanceof Error ? reason.name : "unknown" },
    {
      error: reason instanceof Error ? reason : undefined,
      sentry: true,
    }
  );
});

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
        "│"
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
import webRoutes from "./routes/web/index";
import v1Routes from "./routes/v1/index";
import cliAuthRoutes from "./routes/cli-auth/index";
import workosAuthkitRoutes from "./routes/workos-authkit";
import { rpcLogBus } from "./services/rpc-log-bus";
import { tunnelManager } from "./services/tunnel-manager";
import { shutdownRunningSimulations } from "./services/sessionSimulation/runner";
import {
  isScheduledEvalsWorkerEnabled,
  startScheduledEvalsWorker,
  type ScheduledEvalsWorkerHandle,
} from "./services/scheduled-evals-worker";
import {
  SERVER_PORT,
  CORS_ORIGINS,
  HOSTED_MODE,
  ALLOWED_HOSTS,
  CANIUSE_LANDING_HOSTS,
} from "./config";
import "./types/hono"; // Type extensions
import { initXAAIdpKeyPair } from "./services/xaa-idp-keypair";

// Utility function to extract MCP server config from environment variables
function getMCPConfigFromEnv() {
  // Global options that apply to all modes
  const initialTab = process.env.MCP_INITIAL_TAB || null;
  const cspMode = process.env.MCP_CSP_MODE || null;

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
          }
        );

        // Check for auto-connect server filter
        const autoConnectServer = process.env.MCP_AUTO_CONNECT_SERVER;

        return {
          servers,
          autoConnectServer: autoConnectServer || null,
          initialTab,
          cspMode,
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
    if (initialTab || cspMode) {
      return {
        servers: [],
        initialTab,
        cspMode,
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
    cspMode,
  };
}

function getInspectorFrontendUrlOptions() {
  return {
    isElectron: process.env.ELECTRON_APP === "true",
    isPackaged: process.env.IS_PACKAGED === "true",
    isProduction: process.env.NODE_ENV === "production",
  };
}

// Ensure PATH is initialized from the user's shell so spawned processes can find binaries (e.g., npx)
try {
  fixPath();
} catch {}

// Load environment variables early so route handlers can read CONVEX_HTTP_URL
const loadedEnv = loadInspectorEnv(__dirname);
warnOnConvexDevMisconfiguration(loadedEnv);

// Generate session token for API authentication
generateSessionToken();
initXAAIdpKeyPair();

startGuestAuthProvisioningInBackground();
startLocalBrowserRenderingSetupInBackground();
const app = new Hono().onError((err, c) => {
  appLogger.error("Unhandled error:", err);

  // Return appropriate response
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  return c.json({ error: "Internal server error" }, 500);
});
// WebSocket support (computer terminal bridge). The upgrade handler is
// registered on this app below; `injectWebSocket` is called on the node
// server after `serve()` at the bottom of this file.
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
const strictModeResponse = (c: any, path: string) =>
  c.json(
    {
      code: "FEATURE_NOT_SUPPORTED",
      message: `${path} is disabled in hosted mode`,
    },
    410
  );

// Initialize centralized MCPJam Client Manager and wire RPC logging to SSE bus
const mcpClientManager = new MCPClientManager(
  {},
  {
    retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
    rpcLogger: ({ direction, message, serverId }) => {
      rpcLogBus.publish({
        serverId,
        direction,
        timestamp: new Date().toISOString(),
        message,
      });
    },
  }
);
// Middleware to inject client manager into context
app.use("*", async (c, next) => {
  c.mcpClientManager = mcpClientManager;
  await next();
});

// ===== SECURITY MIDDLEWARE STACK =====
// Order matters: headers -> origin validation -> strict partition -> session auth

// 1. Security headers (always applied)
app.use("*", securityHeadersMiddleware);

// 2. Origin validation (blocks CSRF/DNS rebinding)
app.use("*", originValidationMiddleware);

// 3. Hosted mode partition blocks legacy API families (health endpoints exempt).
if (HOSTED_MODE) {
  app.use("/api/session-token", (c) =>
    strictModeResponse(c, "/api/session-token")
  );
  app.use("/api/mcp", (c, next) => {
    if (c.req.path === "/api/mcp/health") return next();
    return strictModeResponse(c, "/api/mcp/*");
  });
  app.use("/api/mcp/*", (c, next) => {
    if (c.req.path === "/api/mcp/health") return next();
    return strictModeResponse(c, "/api/mcp/*");
  });
  app.use("/api/apps", (c, next) => {
    if (c.req.path === "/api/apps/health") return next();
    return strictModeResponse(c, "/api/apps/*");
  });
  app.use("/api/apps/*", (c, next) => {
    if (c.req.path === "/api/apps/health") return next();
    return strictModeResponse(c, "/api/apps/*");
  });
}

// 4. Session authentication (blocks unauthorized API requests)
app.use("*", sessionAuthMiddleware);

// ===== END SECURITY MIDDLEWARE =====

// Middleware - only enable HTTP request logging in dev mode or when --verbose is passed
const enableHttpLogs =
  process.env.NODE_ENV !== "production" || process.env.VERBOSE_LOGS === "true";
if (enableHttpLogs) {
  // Use custom print function to scrub session tokens from logged URLs
  app.use(
    "*",
    logger((message) => {
      appLogger.info(scrubTokenFromUrl(message));
    })
  );
}
app.use(
  "*",
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
  })
);

app.use(
  "/api/web/*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          code: "VALIDATION_ERROR",
          message: "Request body exceeds 1MB limit",
        },
        400
      ),
  })
);

// Typed event logging context (matches app.ts)
app.use("/api/*", requestLogContextMiddleware);

// API Routes
if (!HOSTED_MODE) {
  app.route("/api/apps", appsRoutes);
  app.route("/api/mcp", mcpRoutes);
} else {
  // Health endpoints always available, even when legacy API families are disabled.
  app.get("/api/mcp/health", (c) =>
    c.json({
      service: "MCP API",
      status: "ready",
      timestamp: new Date().toISOString(),
    })
  );
  app.get("/api/apps/health", (c) =>
    c.json({
      service: "Apps API",
      status: "ready",
      timestamp: new Date().toISOString(),
    })
  );
}
app.route("/api/web", webRoutes);
// Computer terminal WebSocket (Project Computers). Registered directly on
// the root app because the upgrade handler comes from `createNodeWebSocket`;
// auth is the Convex-minted terminal token (see routes/web/computer-terminal).
app.get(
  "/api/web/computers/terminal",
  createComputerTerminalWsHandler(upgradeWebSocket)
);

// Hosted public API (v1). Same 1MB JSON cap as /api/web; routes wrap the same
// core helpers and emit the canonical v1 envelope. Mirror of the mount in
// server/app.ts::createHonoApp — both production entries must wire this up.
app.use(
  "/api/v1/*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          code: "VALIDATION_ERROR",
          message: "Request body exceeds 1MB limit",
        },
        400
      ),
  })
);
app.route("/api/v1", v1Routes);

if (!HOSTED_MODE || process.env.NODE_ENV === "development") {
  app.route("/user_management", workosAuthkitRoutes);
}

// In-process self-dispatch for the workspace built-in tools' platform
// client (see utils/self-app.ts). Mirror of the registration in
// server/app.ts::createHonoApp — both production entries must wire this up.
registerSelfFetch((request) => app.fetch(request));

// CLI OAuth bridge (mcpjam login). Public front-channel routes — no session
// auth (see session-auth.ts UNPROTECTED_PREFIXES) and no tokens returned;
// disabled (501) unless CLI_AUTH_STATE_SECRET + CLI_AUTH_PUBLIC_ORIGIN are
// set. Mirror of the mount in server/app.ts::createHonoApp — both
// production entries must wire this up.
app.route("/api/cli/auth", cliAuthRoutes);

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
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    hasActiveClient: inspectorCommandBus.hasActiveClient(),
    frontend: getInspectorFrontendUrl(getInspectorFrontendUrlOptions()),
  });
});

// Session token endpoint (for dev mode where HTML isn't served by this server)
// Token is only served to localhost or allowed hosts (in hosted mode) to prevent leakage
app.get("/api/session-token", (c) => {
  if (HOSTED_MODE) {
    return strictModeResponse(c, "/api/session-token");
  }

  const host = c.req.header("Host");
  const forwardedHost = c.req.header("X-Forwarded-Host");

  // SECURITY INVARIANT: tunnel hosts never receive the session token, even
  // if a tunnel domain is ever allowlisted — see mayServeSessionToken.
  if (
    !mayServeSessionToken({
      host,
      forwardedHost,
      allowedHosts: ALLOWED_HOSTS,
      hostedMode: HOSTED_MODE,
      activeTunnelDomains: getActiveTunnelDomains(),
    })
  ) {
    appLogger.warn(
      `[Security] Token request denied - non-allowed Host: ${
        forwardedHost || host
      }`
    );
    return c.json(
      { error: "Token only available via localhost or allowed hosts" },
      403
    );
  }

  return c.json({ token: getSessionToken() });
});

// Protected by sessionAuthMiddleware mounted above; the CLI supplies the session token.
app.post("/api/shutdown", (c) => {
  setTimeout(() => {
    void shutdown();
  }, 25);
  return c.json({ ok: true });
});

// API endpoint to get MCP CLI config (for development mode)
app.get("/api/mcp-cli-config", (c) => {
  const mcpConfig = getMCPConfigFromEnv();
  return c.json({ config: mcpConfig });
});

// Static file serving (for production)
if (process.env.NODE_ENV === "production") {
  const clientRoot = "./dist/client";

  // Serve static assets (JS, CSS, images) - no token injection needed
  app.use("/assets/*", serveStatic({ root: clientRoot }));

  // In-app browser redirect (before SPA fallback)
  app.use("/*", inAppBrowserMiddleware);

  // Vanity-domain landing: caniuse.dev (the "Can I use" host-compare showcase)
  // points at this same service, so send its root straight to the chrome-less
  // comparison page (no sidebar/nav, NUX-bypassed). Deep links pass through
  // untouched. Host-gated so app.mcpjam.com and every other domain keep their
  // normal home.
  app.use("/*", async (c, next) => {
    const host = (c.req.header("Host") ?? "").toLowerCase().split(":")[0];
    if (CANIUSE_LANDING_HOSTS.has(host) && c.req.path === "/") {
      return c.redirect("/embed/host-compare", 302);
    }
    return next();
  });

  // Serve all static files from client root (images, svgs, etc.)
  // This handles files like /mcp_jam_light.png, /favicon.ico, etc.
  app.use("/*", serveStatic({ root: clientRoot }));

  // SPA fallback - serve index.html with token injection for non-API routes
  app.get("*", async (c) => {
    const reqPath = c.req.path;
    // Don't intercept API routes
    if (reqPath.startsWith("/api/")) {
      return c.notFound();
    }

    try {
      // Return index.html for SPA routes
      const indexPath = join(process.cwd(), "dist", "client", "index.html");
      let htmlContent = readFileSync(indexPath, "utf-8");

      // SECURITY: Only inject token for localhost or allowed hosts (in hosted mode)
      // This prevents token leakage when bound to 0.0.0.0. Tunnel hosts
      // NEVER receive the token, even if a tunnel domain is ever
      // allowlisted — see mayServeSessionToken.
      const host = c.req.header("Host");
      const forwardedHost = c.req.header("X-Forwarded-Host");

      if (
        mayServeSessionToken({
          host,
          forwardedHost,
          allowedHosts: ALLOWED_HOSTS,
          hostedMode: HOSTED_MODE,
          activeTunnelDomains: getActiveTunnelDomains(),
        })
      ) {
        const token = getSessionToken();
        const tokenScript = `<script>window.__MCP_SESSION_TOKEN__="${token}";</script>`;
        htmlContent = htmlContent.replace("</head>", `${tokenScript}</head>`);
      } else {
        // Non-allowed host access - no token (security measure)
        appLogger.warn(
          `[Security] Token not injected - non-allowed Host: ${host}`
        );
        const warningScript = `<script>console.error("MCPJam: Access via localhost or allowed hosts required for full functionality");</script>`;
        htmlContent = htmlContent.replace("</head>", `${warningScript}</head>`);
      }

      const runtimeConfigScript = getInspectorClientRuntimeConfigScript();
      if (runtimeConfigScript) {
        htmlContent = htmlContent.replace(
          "</head>",
          `${runtimeConfigScript}</head>`
        );
      }

      // Inject MCP server config if provided via CLI
      const mcpConfig = getMCPConfigFromEnv();
      if (mcpConfig) {
        const configScript = `<script>window.MCP_CLI_CONFIG = ${JSON.stringify(
          mcpConfig
        )};</script>`;
        htmlContent = htmlContent.replace("</head>", `${configScript}</head>`);
      }

      // Guest bootstrap blob: mint a guest bearer server-side and inject it so
      // a cold guest boots with a token already in hand (no render-blocking
      // POST /api/web/guest-session). Gated on production + hosted + not
      // locked-down + a host allowlist that includes the hosted app host(s)
      // (mayServeGuestBootstrap), mirroring the session-token discipline.
      //
      // Wrapped in its OWN try/catch so a mint failure never 500s the
      // document — we just serve without the blob and let the client fall
      // back to its POST path.
      if (
        process.env.NODE_ENV === "production" &&
        HOSTED_MODE &&
        process.env.MCPJAM_NONPROD_LOCKDOWN !== "true" &&
        mayServeGuestBootstrap({
          host,
          forwardedHost,
          allowedHosts: ALLOWED_HOSTS,
          hostedMode: HOSTED_MODE,
          activeTunnelDomains: getActiveTunnelDomains(),
        })
      ) {
        try {
          const { session, setCookies } =
            await mintGuestSessionForDocument(c);
          if (session && session.expiresAt > Date.now()) {
            const bootstrapScript = buildGuestBootstrapScript(session);
            htmlContent = htmlContent.replace(
              "</head>",
              `${bootstrapScript}</head>`
            );
            for (const cookie of setCookies) {
              appendGuestSessionSetCookie(c, cookie);
            }
          }
        } catch (error) {
          appLogger.warn(
            "[guest-bootstrap] document mint failed; serving without blob",
            { error: error instanceof Error ? error.message : String(error) }
          );
        }
      }

      // The document may embed a per-guest bearer; never let a shared/browser
      // cache replay one guest's blob to another.
      c.header("Cache-Control", "no-store");

      return c.html(htmlContent);
    } catch (error) {
      appLogger.error("Error serving index.html:", error);
      return c.text("Internal Server Error", 500);
    }
  });
} else {
  // Development mode - in-app browser redirect + API
  app.use("/*", inAppBrowserMiddleware);
  app.get("/", (c) => {
    return c.json({
      message: "MCPJam API Server",
      environment: "development",
      frontend: getInspectorFrontendUrl(getInspectorFrontendUrlOptions()),
    });
  });
}

// Use server configuration
const displayPort = process.env.ENVIRONMENT === "dev" ? 5173 : SERVER_PORT;

/**
 * Network binding strategy:
 *
 * - Native installs: Bind to 127.0.0.1 (localhost only)
 * - Docker: Bind to 0.0.0.0 (required for port forwarding), but Docker
 *   must use -p 127.0.0.1:6274:6274 to restrict host-side access
 *
 * DOCKER_CONTAINER is set in Dockerfile. Do not set manually.
 */
const isDocker = process.env.DOCKER_CONTAINER === "true";
const hostname = isDocker ? "0.0.0.0" : "127.0.0.1";

appLogger.info(`🎵 MCPJam: http://127.0.0.1:${displayPort}`);

// Start the Hono server
const server = serve({
  fetch: app.fetch,
  port: SERVER_PORT,
  hostname,
});
// Attach the WebSocket upgrade listener (computer terminal bridge).
injectWebSocket(server);

// Scheduled eval runs (synthetic monitors): claim-and-execute polling loop.
// Env-gated; the backend cron has its own SCHEDULED_EVALS_ENABLED gate.
let scheduledEvalsWorker: ScheduledEvalsWorkerHandle | undefined;
if (isScheduledEvalsWorkerEnabled()) {
  scheduledEvalsWorker = startScheduledEvalsWorker();
}

const expectedParentPid = Number.parseInt(
  process.env.MCPJAM_INSPECTOR_PARENT_PID ?? "",
  10
);
let orphanCheckInterval: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;
const shutdownForceExitMs = 5000;
const logFlushExitMs = 1000;

function exitAfterLogFlush(code: number) {
  const exitFallbackTimer = setTimeout(
    () => process.exit(code),
    logFlushExitMs
  );
  exitFallbackTimer.unref();

  void appLogger.flush().finally(() => {
    clearTimeout(exitFallbackTimer);
    process.exit(code);
  });
}

// Handle graceful shutdown
async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await scheduledEvalsWorker?.stop();
  if (orphanCheckInterval) {
    clearInterval(orphanCheckInterval);
    orphanCheckInterval = undefined;
  }

  const forceExitTimer = setTimeout(() => {
    appLogger.error(
      "Shutdown timed out; forcing process exit.",
      new Error("Shutdown timed out; forcing process exit.")
    );
    exitAfterLogFlush(1);
  }, shutdownForceExitMs);
  forceExitTimer.unref();

  appLogger.info("Shutting down gracefully...");
  try {
    // Abort active synthetic-session runs and write a terminal "failed"
    // status so the dialog/UI doesn't see a stuck "running" run. Bounded
    // by an internal timeout; the outer `forceExitTimer` still wins.
    await shutdownRunningSimulations();
    await tunnelManager.closeAll();
    server.close();
    await appLogger.flush();
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    appLogger.error("Error during shutdown", error);
    exitAfterLogFlush(1);
  }
}

if (
  Number.isFinite(expectedParentPid) &&
  expectedParentPid > 1 &&
  process.env.MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK !== "1" &&
  !process.versions.electron
) {
  orphanCheckInterval = setInterval(() => {
    if (process.ppid !== expectedParentPid) {
      void shutdown();
    }
  }, 1000);
  orphanCheckInterval.unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default app;
