import { Hono } from "hono";
import { z } from "zod";
import {
  oauthConformanceProfileSchema,
  type HttpServerConfig,
  type MCPServerConfig,
} from "@mcpjam/sdk";
import "../../types/hono";
import { logger } from "../../utils/logger";
import {
  OAuthConformanceSessionFailedError,
  OAuthConformanceSessionNotFoundError,
  UnsupportedTransportError,
  assertHttpSupported,
  completeOAuthConformance,
  runAppsConformance,
  runProtocolConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
} from "../shared/conformance";

const conformance = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────────

type ServerConfigResolution =
  | { config: MCPServerConfig }
  | { error: string; code: string };

function resolveServerConfig(
  mcpClientManager: any,
  serverId: string,
): ServerConfigResolution {
  const serverConfig = mcpClientManager.getServerConfig(serverId) as
    | MCPServerConfig
    | undefined;
  if (!serverConfig) {
    return { error: "Server not connected", code: "notConnected" };
  }
  return { config: serverConfig };
}

function toHttpResolved(config: HttpServerConfig) {
  return {
    serverUrl: String(config.url),
    accessToken: config.accessToken,
    customHeaders: config.requestInit?.headers as
      | Record<string, string>
      | undefined,
  };
}

function handleUnsupportedTransport(
  c: any,
  error: unknown,
): Response | undefined {
  if (error instanceof UnsupportedTransportError) {
    return c.json(
      { success: false, error: error.message, code: error.code },
      400,
    );
  }
  return undefined;
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

    const resolved = resolveServerConfig(c.mcpClientManager, parsed.data.serverId);
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    assertHttpSupported("protocol", resolved.config);
    const { result } = await runProtocolConformance(
      toHttpResolved(resolved.config as HttpServerConfig),
    );
    return c.json({ success: true, result });
  } catch (error) {
    const unsupported = handleUnsupportedTransport(c, error);
    if (unsupported) return unsupported;
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

    const resolved = resolveServerConfig(c.mcpClientManager, parsed.data.serverId);
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    // MCPClientManager stores `url` as a URL object; the SDK expects a string.
    const serverConfig = { ...resolved.config } as MCPServerConfig;
    if ("url" in serverConfig && serverConfig.url) {
      (serverConfig as any).url = String(serverConfig.url);
    }

    const { result } = await runAppsConformance(serverConfig);
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
  oauthProfile: oauthConformanceProfileSchema.optional(),
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

    const { serverId, oauthProfile, runNegativeChecks, callbackOrigin } =
      parsed.data;
    const resolved = resolveServerConfig(c.mcpClientManager, serverId);
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    assertHttpSupported("oauth", resolved.config);
    const http = toHttpResolved(resolved.config as HttpServerConfig);

    if (!callbackOrigin) {
      return c.json(
        {
          success: false,
          error:
            "callbackOrigin is required to run OAuth conformance (browser redirect target)",
          code: "missingCallbackOrigin",
        },
        400,
      );
    }

    const result = await startOAuthConformance({
      defaultServerUrl: http.serverUrl,
      defaultCustomHeaders: http.customHeaders,
      redirectUrl: `${callbackOrigin.replace(/\/$/, "")}/oauth/callback/debug`,
      oauthProfile,
      runNegativeChecks,
    });
    return c.json(result);
  } catch (error) {
    const unsupported = handleUnsupportedTransport(c, error);
    if (unsupported) return unsupported;
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

    const delivered = submitOAuthConformanceCode(parsed.data);
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

    const result = await completeOAuthConformance(parsed.data);
    return c.json(result);
  } catch (error) {
    if (error instanceof OAuthConformanceSessionNotFoundError) {
      return c.json({ success: false, error: error.message }, 404);
    }
    if (error instanceof OAuthConformanceSessionFailedError) {
      return c.json({ success: false, error: error.message }, 500);
    }
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
