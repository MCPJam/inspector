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
  HttpServerConfig,
  MCPServerConfig,
} from "@mcpjam/sdk";
import "../../types/hono";
import { logger } from "../../utils/logger";
import {
  createSession,
  getSession,
  submitAuthorizationCode,
  addCompletedStep,
  setSessionResult,
  setSessionError,
} from "../../services/conformance-oauth-sessions";

const conformance = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────────

function getHttpConfig(
  mcpClientManager: any,
  serverId: string,
): { config: HttpServerConfig } | { error: string; code: string } {
  const serverConfig = mcpClientManager.getServerConfig(serverId) as
    | MCPServerConfig
    | undefined;
  if (!serverConfig) {
    return { error: "Server not connected", code: "notConnected" };
  }
  if (!("url" in serverConfig) || !serverConfig.url) {
    return {
      error: "Protocol conformance requires HTTP transport",
      code: "unsupportedTransport",
    };
  }
  return { config: serverConfig as HttpServerConfig };
}

function getAnyConfig(
  mcpClientManager: any,
  serverId: string,
): { config: MCPServerConfig } | { error: string; code: string } {
  const serverConfig = mcpClientManager.getServerConfig(serverId) as
    | MCPServerConfig
    | undefined;
  if (!serverConfig) {
    return { error: "Server not connected", code: "notConnected" };
  }
  return { config: serverConfig };
}

// ── POST /protocol ──────────────────────────────────────────────────────

const protocolSchema = z.object({
  serverId: z.string().min(1),
});

conformance.post("/protocol", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = protocolSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const { serverId } = parsed.data;
    const mcpClientManager = c.mcpClientManager;
    const resolved = getHttpConfig(mcpClientManager, serverId);

    if ("error" in resolved) {
      return c.json(
        { success: false, error: resolved.error, code: resolved.code },
        400,
      );
    }

    const { config } = resolved;
    const conformanceConfig: MCPConformanceConfig = {
      serverUrl: String(config.url),
      accessToken: config.accessToken,
      customHeaders: config.requestInit?.headers as
        | Record<string, string>
        | undefined,
    };

    const test = new MCPConformanceTest(conformanceConfig);
    const result = await test.run();

    return c.json({ success: true, result });
  } catch (error) {
    logger.error("[Conformance Protocol]", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /apps ──────────────────────────────────────────────────────────

const appsSchema = z.object({
  serverId: z.string().min(1),
});

conformance.post("/apps", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = appsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const { serverId } = parsed.data;
    const mcpClientManager = c.mcpClientManager;
    const resolved = getAnyConfig(mcpClientManager, serverId);

    if ("error" in resolved) {
      return c.json(
        { success: false, error: resolved.error, code: resolved.code },
        400,
      );
    }

    const appsConfig: MCPAppsConformanceConfig =
      resolved.config as MCPAppsConformanceConfig;
    const test = new MCPAppsConformanceTest(appsConfig);
    const result = await test.run();

    return c.json({ success: true, result });
  } catch (error) {
    logger.error("[Conformance Apps]", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /oauth/start ───────────────────────────────────────────────────

const oauthStartSchema = z.object({
  serverId: z.string().min(1),
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
});

conformance.post("/oauth/start", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = oauthStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const { serverId, oauthProfile, runNegativeChecks } = parsed.data;
    const mcpClientManager = c.mcpClientManager;
    const resolved = getHttpConfig(mcpClientManager, serverId);

    if ("error" in resolved) {
      return c.json(
        { success: false, error: resolved.error, code: resolved.code },
        400,
      );
    }

    const { config } = resolved;
    const serverUrl = oauthProfile?.serverUrl || String(config.url);

    const customHeaders =
      oauthProfile?.customHeaders?.reduce(
        (acc, { key, value }) => {
          if (key) acc[key] = value;
          return acc;
        },
        {} as Record<string, string>,
      ) ?? (config.requestInit?.headers as Record<string, string> | undefined);

    // Capture authorization URL via openUrl callback.
    // The SDK's interactive mode uses a loopback server by default.
    // We intercept the openUrl to capture the URL and create a session,
    // then wait for the browser to complete authorization.
    let capturedAuthUrl: string | undefined;
    let sessionId: string | undefined;

    const oauthConfig: OAuthConformanceConfig = {
      serverUrl,
      protocolVersion: (oauthProfile?.protocolVersion as any) || "2025-11-25",
      registrationStrategy:
        (oauthProfile?.registrationStrategy as any) || "cimd",
      auth: {
        mode: "interactive",
        openUrl: async (url: string) => {
          // Capture the authorization URL instead of opening the browser
          capturedAuthUrl = url;
        },
      },
      client: oauthProfile?.clientId
        ? {
            preregistered: {
              clientId: oauthProfile.clientId,
              clientSecret: oauthProfile.clientSecret,
            },
          }
        : undefined,
      scopes: oauthProfile?.scopes,
      customHeaders,
      oauthConformanceChecks: runNegativeChecks ?? false,
    };

    const test = new OAuthConformanceTest(oauthConfig);

    // Start the runner in the background. It will pause at the authorization step
    // where openUrl is called, then wait for the loopback callback.
    const runnerPromise = test.run().then(
      (result) => {
        if (sessionId) setSessionResult(sessionId, result);
        return result;
      },
      (err) => {
        if (sessionId) {
          setSessionError(
            sessionId,
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      },
    );

    // Wait briefly for the authorization URL to be captured via openUrl
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (capturedAuthUrl) {
      // Create a session so the client can track progress
      const session = createSession(capturedAuthUrl);
      sessionId = session.id;
      session.runnerPromise = runnerPromise;

      return c.json({
        phase: "authorization_needed" as const,
        sessionId: session.id,
        authorizationUrl: capturedAuthUrl,
        completedSteps: session.completedSteps,
      });
    }

    // No auth URL captured: test completed without needing authorization
    try {
      const result = await runnerPromise;
      return c.json({ phase: "complete" as const, result });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "OAuth test failed",
        },
        500,
      );
    }
  } catch (error) {
    logger.error("[Conformance OAuth Start]", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /oauth/authorize ───────────────────────────────────────────────

const oauthAuthorizeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1),
  state: z.string().optional(),
});

conformance.post("/oauth/authorize", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = oauthAuthorizeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const { sessionId, code, state } = parsed.data;
    const delivered = submitAuthorizationCode(sessionId, code, state);

    if (!delivered) {
      return c.json(
        {
          success: false,
          error: "Session not found or not waiting for authorization",
        },
        404,
      );
    }

    return c.json({ success: true });
  } catch (error) {
    logger.error("[Conformance OAuth Authorize]", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /oauth/complete ────────────────────────────────────────────────

const oauthCompleteSchema = z.object({
  sessionId: z.string().min(1),
});

conformance.post("/oauth/complete", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = oauthCompleteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const { sessionId } = parsed.data;
    const session = getSession(sessionId);

    if (!session) {
      return c.json(
        { success: false, error: "Session not found or expired" },
        404,
      );
    }

    // If result is already available, return it
    if (session.result) {
      return c.json({
        phase: "complete" as const,
        result: session.result,
      });
    }

    if (session.error) {
      return c.json({ success: false, error: session.error }, 500);
    }

    // Long-poll: wait up to 25 seconds for completion
    const startTime = Date.now();
    const POLL_TIMEOUT_MS = 25_000;
    const POLL_INTERVAL_MS = 500;

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const currentSession = getSession(sessionId);
      if (!currentSession) {
        return c.json({ success: false, error: "Session expired" }, 404);
      }

      if (currentSession.result) {
        return c.json({
          phase: "complete" as const,
          result: currentSession.result,
        });
      }

      if (currentSession.error) {
        return c.json({ success: false, error: currentSession.error }, 500);
      }
    }

    // Timeout: return pending status
    return c.json({
      phase: "pending" as const,
      completedSteps: session.completedSteps,
    });
  } catch (error) {
    logger.error("[Conformance OAuth Complete]", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default conformance;
