import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import fixPath from "fix-path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { webBodyLimit } from "./middleware/web-body-limit.js";
import { logger } from "hono/logger";
import { logger as appLogger } from "./utils/logger";
import { reportRouteFailure } from "./utils/route-error-report.js";
import { attachSocketDiagnostics } from "./utils/socket-diagnostics.js";
import { startProcessVitalsSampler } from "./utils/process-vitals.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { isSpaDocumentRequest } from "./utils/spa-document-request.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  getInspectorClientRuntimeConfigScript,
  loadInspectorEnv,
  warnOnConvexDevMisconfiguration,
} from "./env";
import { initServerSentry } from "./sentry.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "./utils/mcp-retry-policy";
import { cacheEventLogger } from "./utils/cache-events";
import { negotiationTelemetryLogger } from "./utils/negotiation-telemetry";

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
import { startHostedModelCatalogRefresh } from "./services/hosted-model-catalog";
import { inAppBrowserMiddleware } from "./middleware/in-app-browser";
import { startGuestAuthProvisioningInBackground } from "./utils/convex-guest-auth-sync";
import { startLocalBrowserRenderingSetupInBackground } from "./utils/browser-rendering-setup";
import { reportLocalHarnessRuntimeStatusInBackground } from "./utils/harness/local/runtime-install.js";

import { getSystemLogger } from "./utils/request-logger";
import { requestLogContextMiddleware } from "./middleware/request-log-context";
import { getInspectorFrontendUrl } from "./utils/inspector-frontend-url";
import { createComputerTerminalWsHandler } from "./routes/web/computer-terminal";
import {
  createLocalComputerTerminalWsHandler,
  shutdownLocalComputerTerminals,
} from "./routes/web/local-computer-terminal";
import {
  createLocalBrowserFramesWsHandler,
  shutdownLocalBrowserFrameSockets,
} from "./routes/web/local-browser-frames";
import { shutdownLocalBrowserSessions } from "./services/browserd/local/local-browser-session";
import {
  createWebMcpFramesWsHandler,
  shutdownWebMcpFrameSockets,
} from "./routes/web/webmcp-frames.js";
import { shutdownWebMcpSessions } from "./services/webmcp-inspector/session-registry";
import { createComputerUploadHandler } from "./routes/web/computer-upload";
import { initComputersStartup } from "./utils/computers/remote-data-plane";
import { registerSelfFetch } from "./utils/self-app";
import { shutdownAnalytics } from "./utils/analytics";

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
      // Always forward the reason — a non-Error rejection still carries the
      // only clue to what fired (emit stringifies it for Axiom).
      error: reason,
      sentry: true,
    },
  );
});

// Sentry's OnUncaughtException integration owns CAPTURE (and the exit) for
// these; this handler exists only so the crash also lands in Axiom with the
// same shape as every other system event. Deliberately NOT `sentry: true` —
// that would double-count against the integration.
process.on("uncaughtException", (error) => {
  sysLogger.event(
    "process.uncaught_exception",
    { errorCode: error instanceof Error ? error.name : "unknown" },
    { error },
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
import {
  applyHostedPartition,
  mountHostedOpenRoutes,
} from "./middleware/hosted-partition";
import {
  applySandboxHostPartition,
  assertSandboxIsolation,
} from "./middleware/sandbox-host-partition";
import webRoutes from "./routes/web/index";
import internalServerConnections from "./routes/internal/server-connections.js";
import internalEvalJudgeCompletions from "./routes/internal/eval-judge-completions.js";
import internalChatStageDerivations from "./routes/internal/chat-stage-derivations.js";
import internalComputerBrowserDebug from "./routes/internal/computer-browser-debug.js";
import computerBrowserPanel from "./routes/web/computer-browser-panel.js";
import { createComputerBrowserStreamWsHandler } from "./routes/web/computer-browser-stream.js";
import {
  createComputerBrowserFramesWsHandler,
  killBrowserFrameSockets,
  shutdownBrowserFrameSockets,
} from "./routes/web/computer-browser-frames.js";
import { logGradingEngineModeOnce } from "./services/evals/grading-mode.js";
import v1Routes from "./routes/v1/index";
import slackLinkRoutes from "./routes/slack-link/index";
import surfaceLinkRoutes from "./routes/surface-link/index";
import cliAuthRoutes from "./routes/cli-auth/index";
import relayRoutes, { relayBodyLimit } from "./routes/relay";
import { registerXaaClientMetadataRoute } from "./routes/xaa-client-metadata";
import { registerXaaConfidentialCimdRoute } from "./routes/xaa-confidential-cimd";
import { createXaaWebRouter } from "./routes/web/xaa";
import workosAuthkitRoutes from "./routes/workos-authkit";
import { rpcLogBus } from "./services/rpc-log-bus";
import { tunnelManager } from "./services/tunnel-manager";
import { shutdownRunningJourneyRuns } from "./services/sessionSimulation/swarm-runner";
import {
  isScheduledEvalsWorkerEnabled,
  startScheduledEvalsWorker,
  type ScheduledEvalsWorkerHandle,
} from "./services/scheduled-evals-worker";
import {
  isGithubChecksWorkerEnabled,
  startGithubChecksWorker,
  type GithubChecksWorkerHandle,
} from "./services/github-checks-worker";
import {
  startProductionChecksWorker,
  type ProductionChecksWorkerHandle,
} from "./services/production-checks-worker";
import {
  isBenchWorkerEnabled,
  startBenchWorker,
  type BenchWorkerHandle,
} from "./services/bench-worker";
import {
  SERVER_PORT,
  CORS_ORIGINS,
  HOSTED_MODE,
  ALLOWED_HOSTS,
  CANIUSE_LANDING_HOSTS,
  SCORE_LANDING_HOSTS,
} from "./config";
import {
  DEFAULT_DOCUMENT_TITLE_TAG,
  getCaniuseMetaTagsHtml,
  getCaniuseTitleTag,
} from "./utils/caniuse-meta-tags";
import "./types/hono"; // Type extensions
import { initXAAIdpKeyPair, setXaaIdpLogger } from "@mcpjam/sdk";
import { buildHealthMeta } from "./utils/health-payload.js";

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
          },
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
// One line, after the env is loaded: which grading-engine mode this process
// could reach. Mirror of the call in server/app.ts.
logGradingEngineModeOnce();

// Immediately after the env load and before anything that can throw: the init
// reads DO_NOT_TRACK / ENVIRONMENT / VITE_MCPJAM_HOSTED_MODE, which only exist
// once `loadInspectorEnv` has run. Deliberately a call, not an import side
// effect — an import would be hoisted above the env load.
initServerSentry();

// Generate session token for API authentication
generateSessionToken();
setXaaIdpLogger(appLogger);
initXAAIdpKeyPair();

// Warm the hosted-model catalog (seed ∪ backend /v1/models) so billing
// dispatch classifies newly-added hosted models correctly. Memoized.
startHostedModelCatalogRefresh();

startGuestAuthProvisioningInBackground();
startLocalBrowserRenderingSetupInBackground();
// Reports whether a local-harness runtime pack is present. Deliberately
// only REPORTS: a 515 MB agent runtime for a feature behind a flag, a
// kill switch and a consent grant is installed when the user asks, never
// at startup and never during a session start.
reportLocalHarnessRuntimeStatusInBackground();
// Mirror of the call in server/app.ts::createHonoApp — both production
// entries must wire this up. Memoized, so it's harmless if a process ever
// ran both. Kicked off here so it overlaps route setup; AWAITED before
// `serve()` below — synchronous gates (harness pre-flight, evals) read
// `isComputersDataPlaneConfigured()`, which is only truthful once the
// credential bootstrap has resolved.
const computersStartup = initComputersStartup();
const app = new Hono().onError((err, c) => {
  // Last-resort handler: an exception escaped every route and every router's
  // own `onError`. Declared `mcpjam_internal` — if our routers could not name
  // the failure, the unrecognized remainder is ours. The declaration still
  // does not overrule positive evidence, so an ECONNREFUSED that reached here
  // from a user-server hop is classified and stays quiet.
  //
  // Path + method are what make the issue actionable; without them every
  // unhandled route error groups into one blob.
  const { normalized, origin } = reportRouteFailure("Unhandled error", err, {
    source: "app.onError",
    hop: "mcpjam_internal",
    context: { path: c.req.path, method: c.req.method },
  });

  // Hono runs `onError` INSIDE `next()`, so `requestLogContextMiddleware` never
  // observes the throw — it just sees a 500 response. Record the cause here so
  // `http.request.failed` carries something better than "internal_error" with
  // no message. (`/api/web/*` has its own handler that routes through
  // `webError`, which stashes the same shape.)
  c.set("webErrorMeta", {
    status: err instanceof HTTPException ? err.status : 500,
    code:
      err instanceof HTTPException ? "http_exception" : "unhandled_exception",
    message: err instanceof Error ? err.message : String(err),
    // The EFFECTIVE origin, including the internal-boundary promotion — not
    // `originOf(normalized)`, which would report `ambiguous` for a failure
    // Sentry was just paged for as `mcpjam`.
    origin,
    slug: normalized.slug,
  });

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
    410,
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
    // HTTP-exchange capture (headers only). A separate SDK channel from
    // `rpcLogger`: from 2026-07-28 the routing/cross-check metadata a
    // `-32020 HeaderMismatch` is about lives in HTTP headers, which the
    // JSON-RPC body log cannot show. Every era is captured — the legacy
    // session/resumption headers are just as debuggable.
    httpLogger: (exchange) => {
      rpcLogBus.publish({
        kind: "http",
        serverId: exchange.serverId,
        timestamp: new Date().toISOString(),
        exchange,
      });
    },
    // SEP-2549 cache-serve provenance — a channel SEPARATE from rpcLogger
    // (see server/utils/cache-events.ts). Routes opt in per-request via
    // `withCacheEventCapture`; this callback is a no-op outside that scope.
    cacheEventLogger,
    // Auto-negotiation outcome telemetry (always-on negotiation).
    negotiationOutcomeLogger: negotiationTelemetryLogger("local-inspector"),
  },
);
// Middleware to inject client manager into context
app.use("*", async (c, next) => {
  c.mcpClientManager = mcpClientManager;
  await next();
});

// ===== SECURITY MIDDLEWARE STACK =====
// Order matters: headers -> origin validation -> host partition -> strict
// partition -> session auth

// 1. Security headers (always applied)
app.use("*", securityHeadersMiddleware);

// 2. Origin validation (blocks CSRF/DNS rebinding)
app.use("*", originValidationMiddleware);

// 3. Sandbox-host partition: a DNS name that exists to hold untrusted widget
// content serves the sandbox proxy and /health, and 404s the rest — no app
// shell, no assets, no API. Mounted here rather than in the production static
// block below because the API routers mount before that block.
applySandboxHostPartition(app);

// 4. Hosted mode partition blocks legacy API families (health + public
// catalog exempt). Shared with server/app.ts via applyHostedPartition — keep
// the allowlist in middleware/hosted-partition.ts, not inline here.
if (HOSTED_MODE) {
  applyHostedPartition(app);
  // Whether widget content actually has an origin of its own is a fact about
  // the DEPLOY, not about any page: only this process knows which hostnames it
  // was supposed to answer as. Loud, and deliberately not fatal.
  assertSandboxIsolation();
}

// 5. Session authentication (blocks unauthorized API requests)
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

// 1MB JSON cap for /api/web/*, with a carve-out for the computer file-upload
// route (multipart blobs; it applies its own higher bodyLimit at the mount
// site below) and a larger cap for base64 audio transcription bodies. See
// `webBodyLimit`.
app.use("/api/web/*", webBodyLimit());

// Typed event logging context (matches app.ts)
app.use("/api/*", requestLogContextMiddleware);

// API Routes
if (!HOSTED_MODE) {
  app.route("/api/apps", appsRoutes);
  app.route("/api/mcp", mcpRoutes);
} else {
  // Only the hosted-open paths (health + public model catalog) are mounted;
  // the rest of /api/mcp and /api/apps stays 410'd by applyHostedPartition.
  // Mirror of server/app.ts — both entries share mountHostedOpenRoutes.
  mountHostedOpenRoutes(app);
}
// Construct after loadInspectorEnv() so hosted confidential CIMD observes
// Inspector dotenv configuration and malformed configured keys fail startup.
app.route("/api/web/xaa", createXaaWebRouter());
// Backend → inspector doorbell for connection-request work. Gated by its own
// service-token middleware, carries no user identity, and needs none — the
// request id in the body is a selector, not authorization. Mounted ahead of
// /api/web so it never inherits that family's bearer middleware.
// Mirror of the mount in server/app.ts.
app.route("/api/internal/server-connections", internalServerConnections);
// Backend → inspector doorbell for a finished judge. Same shape and the same
// service-token gate; the route resolves the grading-engine mode itself and
// no-ops at `off`/`shadow`, because the backend rings this on every judge save
// without consulting the flag. Mirror of the mount in server/app.ts.
app.route("/api/internal/evals", internalEvalJudgeCompletions);
// Backend → inspector doorbell for a chat session whose chain inputs moved.
// Same service-token gate and the same body-carries-no-authority rule as the
// judge doorbell above — the ring is a wake-up, and the pass claims from the
// backend's own queue rather than from anything the caller named.
app.route("/api/internal/chat-stage", internalChatStageDerivations);
// W1 hosted-browser debug probe — mounted only when explicitly enabled (it
// provisions a desktop and boots browserd end to end), service-token gated.
// Mirror of the mount in server/app.ts.
if (process.env.COMPUTER_BROWSER_DEBUG_ENABLED === "1") {
  app.route(
    "/api/internal/computer-browser-debug",
    internalComputerBrowserDebug,
  );
}
app.route("/api/web", webRoutes);
// Browser Panel data plane (W4): watch the browser an agent is driving, and
// take control when a login or a challenge needs a person. Auth is the
// Convex-minted browser token, so it is mounted like the other computer
// routes rather than inside the web router's session auth. Dark until the
// W7 exposure gate: the panel is only reachable once a desktop computer
// exists, and nothing links to it yet. Mirror of the mount in server/app.ts.
app.route("/api/web/computers/browser", computerBrowserPanel);

// Computer terminal WebSocket (Project Computers). Registered directly on
// the root app because the upgrade handler comes from `createNodeWebSocket`;
// auth is the Convex-minted terminal token (see routes/web/computer-terminal).
app.get(
  "/api/web/computers/terminal",
  createComputerTerminalWsHandler(upgradeWebSocket),
);
// Browser panel stream (W4b). Proxies RFB so the desktop's VNC password stays
// on this replica instead of riding in an iframe URL, and so the handoff lease
// can actually gate a human viewer's keyboard — the daemon never sees these
// packets. Mounted in BOTH modes: a local inspector driving "On my computer"
// has exactly the same credential to protect.
app.get(
  "/api/web/computers/browser/stream",
  createComputerBrowserStreamWsHandler(upgradeWebSocket),
);
// The PAGE, from the daemon's own screencast — the rail's pane. The
// stream above is the whole DESKTOP over RFB, and both stay: one is for
// watching alongside the local engine, the other for taking the machine.
app.get(
  "/api/web/computers/browser/frames",
  createComputerBrowserFramesWsHandler(upgradeWebSocket),
);
// LOCAL computer terminal WebSocket ("This machine"). Never mounted hosted —
// a hosted server must have no path at all to a local PTY. Auth is the
// single-use nonce from POST /api/mcp/computers/local-terminal-token.
if (!HOSTED_MODE) {
  app.get(
    "/api/web/computers/local-terminal",
    createLocalComputerTerminalWsHandler(upgradeWebSocket),
  );
  // The agent browser's viewport, on the same condition and for the same
  // reason: a hosted replica runs no local browser to watch.
  app.get(
    "/api/web/computers/local-browser/frames",
    createLocalBrowserFramesWsHandler(upgradeWebSocket),
  );
}
// WebMCP Inspector frame stream WebSocket. Local only, for the same reason the
// `/api/mcp/webmcp/*` routes are: a hosted replica runs no local browser to
// stream. Auth is the ordinary session token on `Sec-WebSocket-Protocol` —
// see routes/web/webmcp-frames.
if (!HOSTED_MODE) {
  app.get(
    "/api/web/webmcp/sessions/:id/frames",
    createWebMcpFramesWsHandler(upgradeWebSocket),
  );
}
// Computer file upload (drag-and-drop from the Shell panel). Same terminal-token
// auth as the WS above; its own 30MB bodyLimit (the global /api/web/* 1MB cap
// excludes this path). See routes/web/computer-upload.
app.post(
  "/api/web/computers/upload",
  bodyLimit({
    maxSize: 30 * 1024 * 1024,
    onError: (c) =>
      c.json(
        { ok: false, error: "Upload exceeds the 30MB request limit." },
        413,
      ),
  }),
  createComputerUploadHandler(),
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
        400,
      ),
  }),
);
app.route("/api/v1", v1Routes);
// Slack account-link bridge (mirror of the mount in server/app.ts).
app.route("/api/slack/link", slackLinkRoutes);
app.route("/api/surface-link", surfaceLinkRoutes);

// Mounted in EVERY runtime, hosted included. AuthKit's `initialize()` makes no
// network call at all unless the page's own cookies carry `workos-has-session`
// (see create-client.ts in @workos-inc/authkit-js) — and a client pointed
// straight at `api.workos.com` can never have it, because WorkOS sets that
// cookie on its own domain. Staging read as permanently signed out for exactly
// that reason: sign-in succeeded, then the next page load fell back to guest.
//
// Proxying through this origin makes the cookie first-party, which is what
// local dev has always relied on. Hosts that keep a same-site WorkOS domain
// (prod's `auth.mcpjam.com`) never route here — the client only calls this
// when its apiHostname resolves to its own origin. Mirror of the mount in
// server/app.ts.
app.route("/user_management", workosAuthkitRoutes);

// In-process self-dispatch for the workspace built-in tools' platform
// client (see utils/self-app.ts). Mirror of the registration in
// server/app.ts::createHonoApp — both production entries must wire this up.
registerSelfFetch((request) => app.fetch(request));

// CLI OAuth bridge (mcpjam cloud login). Public front-channel routes — no session
// auth (see session-auth.ts UNPROTECTED_PREFIXES) and no tokens returned;
// disabled (501) unless CLI_AUTH_STATE_SECRET + CLI_AUTH_PUBLIC_ORIGIN are
// set. Mirror of the mount in server/app.ts::createHonoApp — both
// production entries must wire this up.
app.route("/api/cli/auth", cliAuthRoutes);

// Same-origin PostHog reverse proxy (ad-blocker resilience). Deliberately
// OUTSIDE /api so it bypasses session auth (analytics flows before any
// session exists), and mounted before the production static/SPA fallback,
// whose catch-all only skips /api/* and would otherwise swallow /relay GETs
// with index.html. Mirror of the mount in server/app.ts::createHonoApp —
// both production entries must wire this up.
// Mounted on BOTH prefixes — see RELAY_MOUNT_PREFIXES in routes/relay.ts:
// /tlm is the alias new clients use because Railway's edge 403s GETs under
// /relay/static and /relay/array on hosted; /relay stays for old builds.
app.use("/relay/*", relayBodyLimit());
app.route("/relay", relayRoutes);
app.use("/tlm/*", relayBodyLimit());
app.route("/tlm", relayRoutes);

// XAA Client ID Metadata Document. Also deliberately OUTSIDE /api (the
// target authorization server fetches it anonymously) and mounted before
// the production static/SPA fallback. Mirror of the mount in
// server/app.ts::createHonoApp — both production entries must wire this up.
registerXaaClientMetadataRoute(app);
registerXaaConfidentialCimdRoute(app);

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    hasActiveClient: inspectorCommandBus.hasActiveClient(),
    frontend: getInspectorFrontendUrl(getInspectorFrontendUrlOptions()),
    ...buildHealthMeta(),
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
      }`,
    );
    return c.json(
      { error: "Token only available via localhost or allowed hosts" },
      403,
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
    // score.mcpjam.com rides the same service: its root lands on the
    // conformance-score runner. `/results/<token>` deep links fall through so
    // a shared result opens directly.
    if (SCORE_LANDING_HOSTS.has(host) && c.req.path === "/") {
      return c.redirect("/embed/score", 302);
    }
    return next();
  });

  // Serve all static files from client root (images, svgs, etc.)
  // This handles files like /mcp_jam_light.png, /favicon.ico, etc.
  //
  // Document requests must fall THROUGH to the injecting handler below —
  // see isSpaDocumentRequest. Without this guard the catch-all answered `/`
  // with the raw index.html and every injected script was silently dropped.
  const clientStaticFiles = serveStatic({ root: clientRoot });
  app.use("/*", async (c, next) => {
    if (isSpaDocumentRequest(c.req.path)) {
      return next();
    }
    return clientStaticFiles(c, next);
  });

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

      // caniuse.dev vanity domain: swap the default MCPJam Inspector title
      // and add its own OG/Twitter card so link previews (Discord, X, Slack)
      // show the host-compare page instead of falling back to the app's
      // generic title-only card. Every other domain keeps the default.
      const landingHost = (c.req.header("Host") ?? "")
        .toLowerCase()
        .split(":")[0];
      if (CANIUSE_LANDING_HOSTS.has(landingHost)) {
        htmlContent = htmlContent.replace(
          DEFAULT_DOCUMENT_TITLE_TAG,
          getCaniuseTitleTag(),
        );
        htmlContent = htmlContent.replace(
          "</head>",
          `${getCaniuseMetaTagsHtml()}</head>`,
        );
      }

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
          `[Security] Token not injected - non-allowed Host: ${host}`,
        );
        const warningScript = `<script>console.error("MCPJam: Access via localhost or allowed hosts required for full functionality");</script>`;
        htmlContent = htmlContent.replace("</head>", `${warningScript}</head>`);
      }

      const runtimeConfigScript = getInspectorClientRuntimeConfigScript();
      if (runtimeConfigScript) {
        htmlContent = htmlContent.replace(
          "</head>",
          `${runtimeConfigScript}</head>`,
        );
      }

      // Inject MCP server config if provided via CLI
      const mcpConfig = getMCPConfigFromEnv();
      if (mcpConfig) {
        const configScript = `<script>window.MCP_CLI_CONFIG = ${JSON.stringify(
          mcpConfig,
        )};</script>`;
        htmlContent = htmlContent.replace("</head>", `${configScript}</head>`);
      }

      // Guest bootstrap blob: mint a guest bearer server-side and inject it so
      // a cold guest boots with a token already in hand (no render-blocking
      // POST /api/web/guest-session). Gated on production + hosted + a host
      // allowlist that includes the hosted app host(s)
      // (mayServeGuestBootstrap), mirroring the session-token discipline.
      //
      // Wrapped in its OWN try/catch so a mint failure never 500s the
      // document — we just serve without the blob and let the client fall
      // back to its POST path.
      if (
        process.env.NODE_ENV === "production" &&
        HOSTED_MODE &&
        mayServeGuestBootstrap({
          host,
          forwardedHost,
          allowedHosts: ALLOWED_HOSTS,
          hostedMode: HOSTED_MODE,
          activeTunnelDomains: getActiveTunnelDomains(),
        })
      ) {
        try {
          const { session, setCookies } = await mintGuestSessionForDocument(c);
          if (session && session.expiresAt > Date.now()) {
            const bootstrapScript = buildGuestBootstrapScript(session);
            htmlContent = htmlContent.replace(
              "</head>",
              `${bootstrapScript}</head>`,
            );
            for (const cookie of setCookies) {
              appendGuestSessionSetCookie(c, cookie);
            }
          }
        } catch (error) {
          appLogger.warn(
            "[guest-bootstrap] document mint failed; serving without blob",
            { error: error instanceof Error ? error.message : String(error) },
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

// Readiness gate: computers credential bootstrap + data-plane discovery must
// resolve before the first request — see initComputersStartup. Bounded (~11s
// worst case, sub-second typical) and never throws.
await computersStartup;

// Start the Hono server
const server = serve({
  fetch: app.fetch,
  port: SERVER_PORT,
  hostname,
});
// Count socket-level failures. These die before Node parses a request line,
// so they emit no `http.request.*` event and are otherwise invisible — the
// class the 08-11 Cloudflare 502 fell into. Must be attached before traffic
// arrives; it also owns the `clientError` response (see the module).
attachSocketDiagnostics(server);
startProcessVitalsSampler();
// Attach the WebSocket upgrade listener (computer terminal bridge).
injectWebSocket(server);

// Scheduled eval runs (synthetic monitors): claim-and-execute polling loop.
// Env-gated; the backend cron has its own SCHEDULED_EVALS_ENABLED gate.
let scheduledEvalsWorker: ScheduledEvalsWorkerHandle | undefined;
if (isScheduledEvalsWorkerEnabled()) {
  scheduledEvalsWorker = startScheduledEvalsWorker();
}

// GitHub PR check runs: claim a PR trigger, build its MCP server in a sandbox,
// run the dedicated eval suite, report an outcome. Env-gated; the backend has
// its own GITHUB_CHECKS_ENABLED gate and 404s the routes when it is off.
let githubChecksWorker: GithubChecksWorkerHandle | undefined;
if (isGithubChecksWorkerEnabled()) {
  githubChecksWorker = startGithubChecksWorker();
}

// Hosted Connector Bench runs: claim a benchmark job, run one eval child per
// matrix cell against the run's pinned server, attach the evidence. Env-gated;
// the backend has its own BENCHMARK_RUNS_ENABLED gate and 404s the routes when
// it is off, which parks this loop on a slow poll.
let benchWorker: BenchWorkerHandle | undefined;
if (isBenchWorkerEnabled()) {
  benchWorker = startBenchWorker();
}

// Production scoring: claim-and-grade polling loop for real User Testing
// sessions. Started unconditionally and deliberately flagless — it self-gates
// on the service-token env (a non-peer deployment gets an inert handle), and
// the feature's single switch is the backend's PRODUCTION_CHECKS_ENABLED,
// which 404s the claim route and parks this loop on a slow poll when off.
const productionChecksWorker: ProductionChecksWorkerHandle =
  startProductionChecksWorker();

const expectedParentPid = Number.parseInt(
  process.env.MCPJAM_INSPECTOR_PARENT_PID ?? "",
  10,
);
let orphanCheckInterval: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;
const shutdownForceExitMs = 5000;
const logFlushExitMs = 1000;

function exitAfterLogFlush(code: number) {
  const exitFallbackTimer = setTimeout(
    () => process.exit(code),
    logFlushExitMs,
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

  // Arm the force-exit deadline FIRST. Both worker `stop()` calls wait for their
  // in-flight work to settle, and a github check legitimately runs for tens of
  // minutes — created after the awaits, this timer would never bound the case it
  // exists for, and a deploy would hang until the platform killed the process.
  const forceExitTimer = setTimeout(() => {
    appLogger.error(
      "Shutdown timed out; forcing process exit.",
      new Error("Shutdown timed out; forcing process exit."),
    );
    exitAfterLogFlush(1);
  }, shutdownForceExitMs);
  forceExitTimer.unref();

  // Cleared BEFORE the worker awaits: a `stop()` that rejects must not leave a
  // live interval behind, and this needs no await of its own.
  if (orphanCheckInterval) {
    clearInterval(orphanCheckInterval);
    orphanCheckInterval = undefined;
  }

  appLogger.info("Shutting down gracefully...");
  try {
    // Inside the guarded path so a rejecting worker still reaches the rest of
    // shutdown rather than skipping straight to the force-exit deadline.
    await scheduledEvalsWorker?.stop();
    await githubChecksWorker?.stop();
    await benchWorker?.stop();
    await productionChecksWorker.stop();
    // Abort active synthetic-session runs and write a terminal "failed"
    // status so the dialog/UI doesn't see a stuck "running" run. Bounded
    // by an internal timeout; the outer `forceExitTimer` still wins.
    // Abort active swarm (journey-execution) runs — stops each run's heartbeat
    // and lets in-flight sessions report a terminal attempt. Bounded internally.
    await shutdownRunningJourneyRuns();
    await tunnelManager.closeAll();
    // Kill local PTYs BEFORE server.close(): close() stops new connections but
    // does NOT tear down established sockets, so a live shell would otherwise
    // outlive the inspector.
    shutdownLocalComputerTerminals();
    // Same reason, same moment: a frame socket is an established connection
    // that `server.close()` would leave attached to an exiting process.
    shutdownWebMcpFrameSockets();
    // Same again for the agent browser's own viewport sockets.
    shutdownLocalBrowserFrameSockets();
    // Hosted panes too: an established WS survives `server.close()`.
    shutdownBrowserFrameSockets();
    // Also before server.close(), and awaited: a WebMCP session owns a real
    // Chromium — a visible window when it is headed — and a fire-and-forget
    // teardown loses the race against the process.exit(0) below.
    await shutdownWebMcpSessions();
    // The agent's own browser, for the same reason and with one more: closing
    // the context is what makes Chromium release its profile's singleton lock,
    // so a skipped teardown here is a browser the NEXT run cannot launch.
    await shutdownLocalBrowserSessions();
    server.close();
    // Flush queued server-side analytics (bounded internally; forceExitTimer
    // is the backstop). Billing/funnel events must not die in the queue.
    await shutdownAnalytics();
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
