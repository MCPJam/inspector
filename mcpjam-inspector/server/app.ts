import { Hono } from "hono";
import fixPath from "fix-path";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { webBodyLimit } from "./middleware/web-body-limit.js";
import { logger } from "hono/logger";
import { logger as appLogger } from "./utils/logger.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

// Import routes
import mcpRoutes from "./routes/mcp/index.js";
import appsRoutes from "./routes/apps/index.js";
import webRoutes from "./routes/web/index.js";
import internalServerConnections from "./routes/internal/server-connections.js";
import internalEvalJudgeCompletions from "./routes/internal/eval-judge-completions.js";
import internalChatStageDerivations from "./routes/internal/chat-stage-derivations.js";
import { logGradingEngineModeOnce } from "./services/evals/grading-mode.js";
import v1Routes from "./routes/v1/index.js";
import cliAuthRoutes from "./routes/cli-auth/index.js";
import slackLinkRoutes from "./routes/slack-link/index.js";
import surfaceLinkRoutes from "./routes/surface-link/index.js";
import relayRoutes, { relayBodyLimit } from "./routes/relay.js";
import { registerXaaClientMetadataRoute } from "./routes/xaa-client-metadata.js";
import { registerXaaConfidentialCimdRoute } from "./routes/xaa-confidential-cimd.js";
import { createXaaWebRouter } from "./routes/web/xaa.js";
import workosAuthkitRoutes from "./routes/workos-authkit.js";
import { MCPClientManager } from "@mcpjam/sdk";
import { initElicitationCallback } from "./routes/mcp/elicitation.js";
import { rpcLogBus } from "./services/rpc-log-bus.js";
import { progressStore } from "./services/progress-store.js";
import { cacheEventLogger } from "./utils/cache-events.js";
import { startProcessVitalsSampler } from "./utils/process-vitals.js";
import { inspectorCommandBus } from "./services/inspector-command-bus.js";
import { CORS_ORIGINS, HOSTED_MODE, ALLOWED_HOSTS } from "./config.js";
import { inAppBrowserMiddleware } from "./middleware/in-app-browser.js";
import path from "path";

// Security imports
import {
  generateSessionToken,
  getSessionToken,
} from "./services/session-token.js";
import {
  mayServeGuestBootstrap,
  mayServeSessionToken,
} from "./utils/localhost-check.js";
import { getActiveTunnelDomains } from "./services/tunnel-registry.js";
import {
  appendGuestSessionSetCookie,
  buildGuestBootstrapScript,
  mintGuestSessionForDocument,
} from "./routes/web/guest-session-shared.js";
import {
  sessionAuthMiddleware,
  scrubTokenFromUrl,
} from "./middleware/session-auth.js";
import { originValidationMiddleware } from "./middleware/origin-validation.js";
import { securityHeadersMiddleware } from "./middleware/security-headers.js";
import {
  getInspectorClientRuntimeConfigScript,
  loadInspectorEnv,
  warnOnConvexDevMisconfiguration,
} from "./env.js";
import { startHostedModelCatalogRefresh } from "./services/hosted-model-catalog.js";
import { startGuestAuthProvisioningInBackground } from "./utils/convex-guest-auth-sync.js";
import { startLocalBrowserRenderingSetupInBackground } from "./utils/browser-rendering-setup.js";
import { fetchRemoteGuestJwks } from "./utils/guest-session-source.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "./utils/mcp-retry-policy.js";
import { negotiationTelemetryLogger } from "./utils/negotiation-telemetry.js";
import { initXAAIdpKeyPair, setXaaIdpLogger } from "@mcpjam/sdk";
import { requestLogContextMiddleware } from "./middleware/request-log-context.js";
import {
  applyHostedPartition,
  mountHostedOpenRoutes,
} from "./middleware/hosted-partition.js";
import { registerSelfFetch } from "./utils/self-app.js";
import { getInspectorFrontendUrl } from "./utils/inspector-frontend-url.js";
import { initComputersStartup } from "./utils/computers/remote-data-plane.js";
import { createNodeWebSocket } from "@hono/node-ws";
import { createComputerTerminalWsHandler } from "./routes/web/computer-terminal.js";
import {
  createLocalComputerTerminalWsHandler,
  killLocalComputerTerminals,
  shutdownLocalComputerTerminals,
} from "./routes/web/local-computer-terminal.js";
import { createComputerUploadHandler } from "./routes/web/computer-upload.js";
import { buildHealthMeta } from "./utils/health-payload.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function createHonoApp() {
  // Load environment variables early so route handlers can read CONVEX_HTTP_URL
  const loadedEnv = loadInspectorEnv(__dirname);
  warnOnConvexDevMisconfiguration(loadedEnv);
  // One line, after the env is loaded: which grading-engine mode this process
  // could reach. An operator debugging "why are there no score rows" should
  // find the answer in the log, not in a flag dashboard.
  logGradingEngineModeOnce();

  // Under Electron this process IS the main process, and it is the one that
  // ran out of heap in INSPECTOR-ELECTRON-W3 with no session telemetry at all.
  // Started here rather than in `src/main.ts` so the npm-package server gets it
  // too, and so the sampler sits next to the buffers it reports on.
  startProcessVitalsSampler();

  // Ensure PATH includes user shell paths so child processes (e.g., npx) can be found
  // This is crucial when launched from GUI apps (Electron) where PATH is minimal
  try {
    fixPath();
  } catch {}

  // Generate session token for API authentication
  generateSessionToken();
  setXaaIdpLogger(appLogger);
  initXAAIdpKeyPair();

  // Warm the hosted-model catalog (seed ∪ backend /v1/models) so billing
  // dispatch classifies newly-added hosted models correctly. Memoized.
  startHostedModelCatalogRefresh();

  startGuestAuthProvisioningInBackground();
  startLocalBrowserRenderingSetupInBackground();
  // Mirror of the call in server/index.ts — both production entries must
  // wire this up so the Electron/embedded path also gets a working Computer
  // tab. Memoized, so it's harmless if a process ever ran both. AWAITED (the
  // factory is async for exactly this): synchronous gates read
  // `isComputersDataPlaneConfigured()`, which is only truthful once the
  // credential bootstrap has resolved — no requests before that.
  await initComputersStartup();

  const app = new Hono();
  // Computer terminal WebSocket support (Project Computers). Mirror of
  // server/index.ts — the Electron/embedded entry must wire the SAME upgrade
  // handler so the Computer tab's Shell + drag-and-drop upload work here too.
  // `injectWebSocket` is returned to the caller (src/main.ts) to attach to the
  // node server, exactly as server/index.ts calls it on its own server.
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  const strictModeResponse = (c: any, path: string) =>
    c.json(
      {
        code: "FEATURE_NOT_SUPPORTED",
        message: `${path} is disabled in hosted mode`,
      },
      410
    );
  const isElectron = process.env.ELECTRON_APP === "true";
  const isProduction = process.env.NODE_ENV === "production";
  const isPackaged = process.env.IS_PACKAGED === "true";
  const frontendUrl = getInspectorFrontendUrl({
    isElectron,
    isPackaged,
    isProduction,
  });

  // Create the MCPJam client manager instance and wire RPC logging to SSE bus
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
      // SEP-2549 cache-serve provenance — a channel SEPARATE from rpcLogger
      // (see server/utils/cache-events.ts). Routes opt in per-request via
      // `withCacheEventCapture`; this callback is a no-op outside that scope.
      cacheEventLogger,
      // Auto-negotiation outcome telemetry (always-on negotiation).
      negotiationOutcomeLogger: negotiationTelemetryLogger("local-inspector"),
    }
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

  // Request log context (mounted BEFORE the security stack so that 401s from
  // session auth, 403s from origin validation, and hosted-mode 410 partition
  // responses are still observed in Axiom — those are exactly the requests
  // SREs want to see during an outage or attack).
  app.use("/api/*", requestLogContextMiddleware);

  // ===== SECURITY MIDDLEWARE STACK =====
  // Order matters: headers -> origin validation -> strict partition -> session auth

  // 1. Security headers (always applied)
  app.use("*", securityHeadersMiddleware);

  // 2. Origin validation (blocks CSRF/DNS rebinding)
  app.use("*", originValidationMiddleware);

  // 3. Hosted mode partition blocks legacy API families (health + public
  // catalog exempt). Shared with server/index.ts via applyHostedPartition —
  // keep the allowlist in middleware/hosted-partition.ts, not inline here.
  if (HOSTED_MODE) {
    applyHostedPartition(app);
  }

  // 4. Session authentication (blocks unauthorized API requests)
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

  // Hosted web APIs enforce a 1MB max JSON body — except the cloud-skills
  // folder upload, which is multipart and bounded by the service caps. Audio
  // transcription gets its own larger cap inside the helper. See
  // `webBodyLimit`.
  app.use("/api/web/*", webBodyLimit());

  // API Routes
  if (!HOSTED_MODE) {
    app.route("/api/apps", appsRoutes);
    app.route("/api/mcp", mcpRoutes);
  } else {
    // Only the hosted-open paths (health + public model catalog) are mounted;
    // the rest of /api/mcp and /api/apps stays 410'd by applyHostedPartition.
    // Mirror of server/index.ts — both entries share mountHostedOpenRoutes.
    mountHostedOpenRoutes(app);
  }
  // Construct after loadInspectorEnv() so hosted confidential CIMD observes
  // Inspector dotenv configuration and malformed configured keys fail startup.
  app.route("/api/web/xaa", createXaaWebRouter());
  // Backend → inspector doorbell for connection-request work. Gated by its own
  // service-token middleware, carries no user identity, and needs none — the
  // request id in the body is a selector, not authorization. Mounted ahead of
  // /api/web so it never inherits that family's bearer middleware.
  // Mirror of the mount in server/index.ts.
  app.route("/api/internal/server-connections", internalServerConnections);
  // Backend → inspector doorbell for a finished judge. Same shape and the same
  // service-token gate; the route resolves the grading-engine mode itself and
  // no-ops at `off`/`shadow`, because the backend rings this on every judge
  // save without consulting the flag. Mirror of the mount in server/index.ts.
  app.route("/api/internal/evals", internalEvalJudgeCompletions);
  // Backend → inspector doorbell for a chat session whose chain inputs moved.
  // Same service-token gate and the same body-carries-no-authority rule as the
  // judge doorbell above — the ring is a wake-up, and the pass claims from the
  // backend's own queue rather than from anything the caller named.
  app.route("/api/internal/chat-stage", internalChatStageDerivations);
  app.route("/api/web", webRoutes);
  // Computer terminal WebSocket + file upload (Project Computers). Registered
  // directly on the root app because the WS upgrade handler comes from
  // `createNodeWebSocket`; the upload route carries its own 30MB bodyLimit (the
  // global /api/web/* 1MB cap excludes this path). Mirror of the mount in
  // server/index.ts — both production entries must wire this up, else the
  // Electron/embedded entry 404s these paths. When computers aren't configured
  // the handlers return a clean 503 (not a raw 404).
  app.get(
    "/api/web/computers/terminal",
    createComputerTerminalWsHandler(upgradeWebSocket)
  );
  // LOCAL computer terminal WebSocket ("This machine"). Never mounted hosted.
  // Mirror of the mount in server/index.ts.
  if (!HOSTED_MODE) {
    app.get(
      "/api/web/computers/local-terminal",
      createLocalComputerTerminalWsHandler(upgradeWebSocket)
    );
  }
  app.post(
    "/api/web/computers/upload",
    bodyLimit({
      maxSize: 30 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { ok: false, error: "Upload exceeds the 30MB request limit." },
          413
        ),
    }),
    createComputerUploadHandler()
  );

  // Hosted public API (v1). Same 1MB JSON cap as /api/web; the canonical
  // resource-oriented routes wrap the same core helpers and emit the v1
  // envelope. Read-only diagnostics first; mutating ops land behind the
  // X-MCPJam-Approval flow in a follow-up.
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

  // CLI OAuth bridge (mcpjam cloud login). Public front-channel routes — no session
  // auth (see session-auth.ts UNPROTECTED_PREFIXES) and no tokens returned;
  // disabled (501) unless CLI_AUTH_STATE_SECRET + CLI_AUTH_PUBLIC_ORIGIN are
  // set. Mirror of the mount in server/index.ts — both production entries
  // must wire this up.
  app.route("/api/cli/auth", cliAuthRoutes);

  // Slack account-link bridge. Public front-channel like the CLI bridge (no
  // session auth — the user is not signed in yet; that is what the flow
  // establishes), and 501 unless the Slack/WorkOS client credentials and
  // SLACK_LINK_STATE_SECRET are configured. Mirror of the mount in
  // server/index.ts — both production entries must wire this up.
  app.route("/api/slack/link", slackLinkRoutes);
  app.route("/api/surface-link", surfaceLinkRoutes);

  // Same-origin PostHog reverse proxy (ad-blocker resilience). Deliberately
  // OUTSIDE /api so it bypasses session auth (analytics flows before any
  // session exists), and mounted before the static/SPA fallback, whose
  // catch-all only skips /api/* and would otherwise swallow /relay GETs
  // with index.html. Mirror of the mount in server/index.ts — both
  // production entries must wire this up.
  // Mounted on BOTH prefixes — see RELAY_MOUNT_PREFIXES in routes/relay.ts:
  // /tlm is the alias new clients use because Railway's edge 403s GETs under
  // /relay/static and /relay/array on hosted; /relay stays for old builds.
  app.use("/relay/*", relayBodyLimit());
  app.route("/relay", relayRoutes);
  app.use("/tlm/*", relayBodyLimit());
  app.route("/tlm", relayRoutes);

  // XAA Client ID Metadata Document. Also deliberately OUTSIDE /api (the
  // target authorization server fetches it anonymously) and mounted before
  // the static/SPA fallback. Mirror of the mount in server/index.ts — both
  // production entries must wire this up.
  registerXaaClientMetadataRoute(app);
  registerXaaConfidentialCimdRoute(app);

  // Health check
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      hasActiveClient: inspectorCommandBus.hasActiveClient(),
      frontend: frontendUrl,
      ...buildHealthMeta(),
    });
  });

  // Guest JWT JWKS compatibility endpoint — public, no auth required.
  // The canonical JWKS now lives on Convex; Inspector proxies it here.
  app.get("/guest/jwks", async () => {
    const response = await fetchRemoteGuestJwks();
    if (!response) {
      return Response.json(
        { error: "Guest JWKS unavailable" },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      );
    }

    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "Cache-Control":
          response.headers.get("cache-control") || "public, max-age=300",
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      },
    });
  });

  // Session token endpoint (for dev mode where HTML isn't served by this server)
  // Token is only served to localhost or allowed hosts (in hosted mode)
  app.get("/api/session-token", (c) => {
    if (HOSTED_MODE) {
      return strictModeResponse(c, "/api/session-token");
    }

    const host = c.req.header("Host");
    const forwardedHost = c.req.header("X-Forwarded-Host");

    // SECURITY INVARIANT: tunnel hosts never receive the session token, even
    // if a tunnel domain is ever allowlisted — see mayServeSessionToken. This
    // used to call `isAllowedHost` directly, which is the same allowlist
    // WITHOUT the tunnel veto, so `index.ts` and this file disagreed about the
    // one rule they must not disagree about.
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
        `[Security] Token request denied - Host not allowed: ${
          forwardedHost || host
        }`
      );
      return c.json({ error: "Token only available via allowed hosts" }, 403);
    }

    return c.json({ token: getSessionToken() });
  });

  // Static hosting / dev redirect behavior
  if (isProduction || (isElectron && isPackaged)) {
    // Production (web) or Electron packaged build: serve files from bundled client
    let root = "./dist/client";
    if (isElectron && isPackaged) {
      root = path.resolve(process.env.ELECTRON_RESOURCES_PATH!, "client");
    }

    // Serve static assets (JS, CSS, images) - no token injection needed
    app.use("/assets/*", serveStatic({ root }));

    // In-app browser redirect: detect embedded WebViews (LinkedIn, Facebook, etc.)
    // and serve a redirect page before the SPA loads, since Google OAuth blocks
    // sign-in from in-app browsers with `disallowed_useragent`.
    app.use("/*", inAppBrowserMiddleware);

    // Serve all static files from client root (images, svgs, etc.)
    // This handles files like /mcp_jam_light.png, /favicon.ico, etc.
    app.use("/*", serveStatic({ root }));

    // For HTML pages, inject the session token (only for localhost requests)
    app.get("/*", async (c) => {
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
        const forwardedHost = c.req.header("X-Forwarded-Host");

        // Same invariant as the /api/session-token route above, and the same
        // bug: this path already captured `forwardedHost` for the guest
        // bootstrap below but did not consult it here, so a request arriving
        // through the relay edge — which puts the real tunnel host in
        // X-Forwarded-Host — got the token injected into its document.
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
          html = html.replace("</head>", `${tokenScript}</head>`);
        } else {
          // Host not allowed - no token (security measure)
          appLogger.warn(
            `[Security] Token not injected - Host not allowed: ${host}`
          );
          const warningScript = `<script>console.error("MCPJam: Access via allowed host required for full functionality");</script>`;
          html = html.replace("</head>", `${warningScript}</head>`);
        }

        const runtimeConfigScript = getInspectorClientRuntimeConfigScript();
        if (runtimeConfigScript) {
          html = html.replace("</head>", `${runtimeConfigScript}</head>`);
        }

        // Guest bootstrap blob: mint a guest bearer server-side and inject it
        // so a cold guest boots with a token already in hand. Gated on
        // production + hosted + a host allowlist that includes the hosted app
        // host(s) (mayServeGuestBootstrap), mirroring the session-token
        // discipline. Wrapped in its own try/catch so a mint failure never
        // 500s the document.
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
            const { session, setCookies } = await mintGuestSessionForDocument(
              c
            );
            if (session && session.expiresAt > Date.now()) {
              const bootstrapScript = buildGuestBootstrapScript(session);
              html = html.replace("</head>", `${bootstrapScript}</head>`);
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

        // The document may embed a per-guest bearer; never let a
        // shared/browser cache replay one guest's blob to another.
        c.header("Cache-Control", "no-store");

        return c.html(html);
      } catch (error) {
        appLogger.error("Error serving index.html:", error);
        return c.text("Internal Server Error", 500);
      }
    });
  } else if (isElectron && !isPackaged) {
    // Electron development: redirect any front-end route to the renderer dev server
    app.get("/*", (c) => {
      const target = new URL(c.req.path, frontendUrl).toString();
      return c.redirect(target, 307);
    });
  } else {
    // Development mode - in-app browser redirect + API
    app.use("/*", inAppBrowserMiddleware);
    app.get("/", (c) => {
      return c.json({
        message: "MCPJam API Server",
        environment: "development",
        frontend: frontendUrl,
      });
    });
  }

  // In-process self-dispatch for the workspace built-in tools' platform
  // client (see utils/self-app.ts) — their /api/v1 calls skip the network.
  registerSelfFetch((request) => app.fetch(request));

  // Return `injectWebSocket` alongside the app so the caller (src/main.ts) can
  // attach the WS upgrade handler to its node server — same as server/index.ts.
  // The two PTY-cleanup hooks ride along for the same reason: the Electron entry
  // owns this process's lifecycle and must kill live local PTYs itself
  // (server.close() does not close established sockets). `shutdown…` latches
  // and belongs on a real quit; `kill…` does not and belongs on
  // `window-all-closed`, which on macOS is followed by a server RESTART.
  return {
    app,
    injectWebSocket,
    shutdownLocalComputerTerminals,
    killLocalComputerTerminals,
  };
}
