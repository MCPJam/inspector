import { Hono } from "hono";
import { z } from "zod";
import {
  MCPConformanceTest,
  MCPAppsConformanceTest,
  OAuthConformanceTest,
} from "@mcpjam/sdk";
import type {
  MCPConformanceConfig,
  MCPAppsConformanceConfig,
  OAuthConformanceConfig,
} from "@mcpjam/sdk";
import {
  createAuthorizedManager,
  withManager,
  handleRoute,
  workspaceServerSchema,
  guestServerInputSchema,
  type ConvexAuthorizeResponse,
} from "./auth.js";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./errors.js";
import { logger } from "../../utils/logger.js";
import { validateUrl, OAuthProxyError } from "../../utils/oauth-proxy.js";
import {
  createSession,
  getSession,
  submitAuthorizationCode,
  setSessionResult,
  setSessionError,
} from "../../services/conformance-oauth-sessions.js";
import { authorizeServer, toHttpConfig } from "./auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";

const conformanceWeb = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────────

/** Detect guest vs workspace request by body shape. */
function isGuestRequest(body: Record<string, unknown>): boolean {
  return typeof body.serverUrl === "string" && !body.workspaceId;
}

/** Resolve HTTP server URL and headers for conformance from authorized config. */
async function resolveHostedHttpConfig(
  bearerToken: string,
  body: Record<string, unknown>,
): Promise<{
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
}> {
  if (isGuestRequest(body)) {
    // Guest: direct server URL
    const guestInput = parseWithSchema(guestServerInputSchema, body);
    try {
      await validateUrl(guestInput.serverUrl, true);
    } catch (err) {
      if (err instanceof OAuthProxyError) {
        throw new WebRouteError(err.status, ErrorCode.VALIDATION_ERROR, err.message);
      }
      throw err;
    }
    const oauthToken = typeof body.oauthAccessToken === "string" ? body.oauthAccessToken : undefined;
    return {
      serverUrl: guestInput.serverUrl,
      accessToken: oauthToken,
      customHeaders: guestInput.serverHeaders,
    };
  }

  // Workspace: authorize via Convex
  const wsBody = parseWithSchema(workspaceServerSchema, body);
  const auth = await authorizeServer(bearerToken, wsBody.workspaceId, wsBody.serverId, {
    accessScope: wsBody.accessScope,
    shareToken: wsBody.shareToken,
    sandboxToken: wsBody.sandboxToken,
  });

  if (auth.serverConfig.transportType !== "http") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Protocol conformance requires HTTP transport",
    );
  }

  if (!auth.serverConfig.url) {
    throw new WebRouteError(500, ErrorCode.INTERNAL_ERROR, "Authorized server is missing URL");
  }

  const oauthToken = typeof wsBody.oauthAccessToken === "string" ? wsBody.oauthAccessToken : undefined;
  const headers: Record<string, string> = { ...(auth.serverConfig.headers ?? {}) };
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
  }

  return {
    serverUrl: auth.serverConfig.url,
    accessToken: oauthToken ? undefined : undefined, // OAuth token goes in headers
    customHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

/** Resolve any-transport server config for Apps conformance on hosted. */
async function resolveHostedServerConfig(
  bearerToken: string,
  body: Record<string, unknown>,
): Promise<MCPAppsConformanceConfig> {
  if (isGuestRequest(body)) {
    const guestInput = parseWithSchema(guestServerInputSchema, body);
    try {
      await validateUrl(guestInput.serverUrl, true);
    } catch (err) {
      if (err instanceof OAuthProxyError) {
        throw new WebRouteError(err.status, ErrorCode.VALIDATION_ERROR, err.message);
      }
      throw err;
    }
    const oauthToken = typeof body.oauthAccessToken === "string" ? body.oauthAccessToken : undefined;
    const headers: Record<string, string> = { ...(guestInput.serverHeaders ?? {}) };
    if (oauthToken) {
      headers["Authorization"] = `Bearer ${oauthToken}`;
    }
    return {
      url: guestInput.serverUrl,
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      timeout: WEB_CALL_TIMEOUT_MS,
    } as MCPAppsConformanceConfig;
  }

  // Workspace: authorize via Convex
  const wsBody = parseWithSchema(workspaceServerSchema, body);
  const auth = await authorizeServer(bearerToken, wsBody.workspaceId, wsBody.serverId, {
    accessScope: wsBody.accessScope,
    shareToken: wsBody.shareToken,
    sandboxToken: wsBody.sandboxToken,
  });

  const httpConfig = toHttpConfig(
    auth,
    WEB_CALL_TIMEOUT_MS,
    typeof wsBody.oauthAccessToken === "string" ? wsBody.oauthAccessToken : undefined,
    wsBody.clientCapabilities as Record<string, unknown> | undefined,
  );

  return httpConfig as MCPAppsConformanceConfig;
}

// ── POST /protocol ──────────────────────────────────────────────────────

conformanceWeb.post("/protocol", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(bearerToken, body);

    const conformanceConfig: MCPConformanceConfig = {
      serverUrl: resolved.serverUrl,
      accessToken: resolved.accessToken,
      customHeaders: resolved.customHeaders,
    };

    const test = new MCPConformanceTest(conformanceConfig);
    const result = await test.run();
    return { success: true, result };
  }),
);

// ── POST /apps ──────────────────────────────────────────────────────────

conformanceWeb.post("/apps", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const config = await resolveHostedServerConfig(bearerToken, body);

    const test = new MCPAppsConformanceTest(config);
    const result = await test.run();
    return { success: true, result };
  }),
);

// ── POST /oauth/start ───────────────────────────────────────────────────

const oauthStartSchema = z
  .object({
    oauthProfile: z
      .object({
        serverUrl: z.string().optional(),
        protocolVersion: z.string().optional(),
        registrationStrategy: z.string().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scopes: z.string().optional(),
        customHeaders: z
          .array(z.object({ key: z.string(), value: z.string() }))
          .optional(),
      })
      .optional(),
    runNegativeChecks: z.boolean().optional(),
    callbackOrigin: z.string().optional(),
  })
  .passthrough(); // Allow workspace/guest fields to pass through

conformanceWeb.post("/oauth/start", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(bearerToken, body);
    const parsed = parseWithSchema(oauthStartSchema, body);

    const serverUrl = parsed.oauthProfile?.serverUrl || resolved.serverUrl;
    const callbackOrigin = parsed.callbackOrigin;
    const redirectUrl = callbackOrigin
      ? `${callbackOrigin}/oauth/callback/debug`
      : undefined;

    const customHeaders =
      parsed.oauthProfile?.customHeaders?.reduce(
        (acc, { key, value }) => {
          if (key) acc[key] = value;
          return acc;
        },
        {} as Record<string, string>,
      ) ?? resolved.customHeaders;

    // Build OAuth conformance config with interactive mode using custom redirect
    const oauthConfig: OAuthConformanceConfig = {
      serverUrl,
      protocolVersion: (parsed.oauthProfile?.protocolVersion as any) || "2025-11-25",
      registrationStrategy: (parsed.oauthProfile?.registrationStrategy as any) || "cimd",
      auth: {
        mode: "interactive",
        openUrl: async () => {
          /* no-op: we capture the URL via the session instead */
        },
      },
      client: parsed.oauthProfile?.clientId
        ? {
            preregistered: {
              clientId: parsed.oauthProfile.clientId,
              clientSecret: parsed.oauthProfile.clientSecret,
            },
          }
        : undefined,
      scopes: parsed.oauthProfile?.scopes,
      customHeaders,
      redirectUrl,
      oauthConformanceChecks: parsed.runNegativeChecks ?? false,
    };

    // Run OAuth conformance with a custom interactive session
    // that pauses at authorization and captures the URL
    let sessionId: string | undefined;
    let capturedAuthUrl: string | undefined;
    let waitForCode: Promise<{ code: string }> | undefined;

    const test = new OAuthConformanceTest(oauthConfig, {
      createInteractiveAuthorizationSession: async (options) => {
        const effectiveRedirectUrl = redirectUrl || options?.redirectUrl || `http://127.0.0.1:0/callback`;

        return {
          redirectUrl: effectiveRedirectUrl,
          authorize: async (input) => {
            capturedAuthUrl = input.authorizationUrl;

            const session = createSession(input.authorizationUrl, input.expectedState);
            sessionId = session.id;

            // Wait for code from POST /oauth/authorize
            const codePromise = new Promise<{ code: string }>((resolve, reject) => {
              session.codeResolver = ({ code }) => resolve({ code });
              session.codeRejecter = reject;

              setTimeout(() => {
                reject(new Error("OAuth authorization timed out"));
              }, input.timeoutMs || 120_000);
            });
            waitForCode = codePromise;

            return codePromise;
          },
          stop: async () => {
            /* cleanup handled by session TTL */
          },
        };
      },
    });

    // Start runner in background
    const runnerPromise = test.run().then(
      (result) => {
        if (sessionId) setSessionResult(sessionId, result);
        return result;
      },
      (err) => {
        if (sessionId) {
          setSessionError(sessionId, err instanceof Error ? err.message : String(err));
        }
        throw err;
      },
    );

    // Wait briefly for the authorization URL to be captured
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (capturedAuthUrl && sessionId) {
      const session = getSession(sessionId);
      if (session) {
        session.runnerPromise = runnerPromise;
      }

      return {
        phase: "authorization_needed" as const,
        sessionId,
        authorizationUrl: capturedAuthUrl,
        completedSteps: session?.completedSteps ?? [],
      };
    }

    // No auth URL captured: test may have completed or doesn't need OAuth
    try {
      const result = await runnerPromise;
      return { phase: "complete" as const, result };
    } catch (error) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        error instanceof Error ? error.message : "OAuth test failed",
      );
    }
  }),
);

// ── POST /oauth/authorize ───────────────────────────────────────────────

const oauthAuthorizeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1),
  state: z.string().optional(),
});

conformanceWeb.post("/oauth/authorize", async (c) =>
  handleRoute(c, async () => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    const parsed = parseWithSchema(oauthAuthorizeSchema, body);

    const delivered = submitAuthorizationCode(parsed.sessionId, parsed.code, parsed.state);
    if (!delivered) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Session not found or not waiting for authorization",
      );
    }

    return { success: true };
  }),
);

// ── POST /oauth/complete ────────────────────────────────────────────────

const oauthCompleteSchema = z.object({
  sessionId: z.string().min(1),
});

conformanceWeb.post("/oauth/complete", async (c) =>
  handleRoute(c, async () => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    const parsed = parseWithSchema(oauthCompleteSchema, body);

    const session = getSession(parsed.sessionId);
    if (!session) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Session not found or expired");
    }

    if (session.result) {
      return { phase: "complete" as const, result: session.result };
    }

    if (session.error) {
      throw new WebRouteError(500, ErrorCode.INTERNAL_ERROR, session.error);
    }

    // Long-poll: wait up to 25 seconds
    const POLL_TIMEOUT_MS = 25_000;
    const POLL_INTERVAL_MS = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const currentSession = getSession(parsed.sessionId);
      if (!currentSession) {
        throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Session expired");
      }

      if (currentSession.result) {
        return { phase: "complete" as const, result: currentSession.result };
      }

      if (currentSession.error) {
        throw new WebRouteError(500, ErrorCode.INTERNAL_ERROR, currentSession.error);
      }
    }

    return {
      phase: "pending" as const,
      completedSteps: session.completedSteps,
    };
  }),
);

export default conformanceWeb;
