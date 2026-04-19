import { Hono } from "hono";
import { z } from "zod";
import {
  oauthConformanceProfileSchema,
  type MCPAppsConformanceConfig,
} from "@mcpjam/sdk";
import {
  handleRoute,
  workspaceServerSchema,
  guestServerInputSchema,
} from "./auth.js";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./errors.js";
import { validateUrl, OAuthProxyError } from "../../utils/oauth-proxy.js";
import {
  OAuthConformanceSessionFailedError,
  OAuthConformanceSessionNotFoundError,
  UnsupportedTransportError,
  completeOAuthConformance,
  runAppsConformance,
  runProtocolConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
} from "../shared/conformance";
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
        throw new WebRouteError(
          err.status,
          ErrorCode.VALIDATION_ERROR,
          err.message,
        );
      }
      throw err;
    }
    const oauthToken =
      typeof body.oauthAccessToken === "string"
        ? body.oauthAccessToken
        : undefined;
    return {
      serverUrl: guestInput.serverUrl,
      accessToken: oauthToken,
      customHeaders: guestInput.serverHeaders,
    };
  }

  // Workspace: authorize via Convex
  const wsBody = parseWithSchema(workspaceServerSchema, body);
  const auth = await authorizeServer(
    bearerToken,
    wsBody.workspaceId,
    wsBody.serverId,
    {
      accessScope: wsBody.accessScope,
      shareToken: wsBody.shareToken,
      sandboxToken: wsBody.sandboxToken,
    },
  );

  if (auth.serverConfig.transportType !== "http") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Protocol conformance requires HTTP transport",
    );
  }

  if (!auth.serverConfig.url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorized server is missing URL",
    );
  }

  const oauthToken =
    typeof wsBody.oauthAccessToken === "string"
      ? wsBody.oauthAccessToken
      : undefined;
  const headers: Record<string, string> = {
    ...(auth.serverConfig.headers ?? {}),
  };
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
  }

  return {
    serverUrl: auth.serverConfig.url,
    accessToken: undefined, // OAuth token goes in headers
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
        throw new WebRouteError(
          err.status,
          ErrorCode.VALIDATION_ERROR,
          err.message,
        );
      }
      throw err;
    }
    const oauthToken =
      typeof body.oauthAccessToken === "string"
        ? body.oauthAccessToken
        : undefined;
    const headers: Record<string, string> = {
      ...(guestInput.serverHeaders ?? {}),
    };
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
  const auth = await authorizeServer(
    bearerToken,
    wsBody.workspaceId,
    wsBody.serverId,
    {
      accessScope: wsBody.accessScope,
      shareToken: wsBody.shareToken,
      sandboxToken: wsBody.sandboxToken,
    },
  );

  const httpConfig = toHttpConfig(
    auth,
    WEB_CALL_TIMEOUT_MS,
    typeof wsBody.oauthAccessToken === "string"
      ? wsBody.oauthAccessToken
      : undefined,
    wsBody.clientCapabilities as Record<string, unknown> | undefined,
  );

  return httpConfig as MCPAppsConformanceConfig;
}

function toWebError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  if (error instanceof UnsupportedTransportError) {
    return new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      error.message,
    );
  }
  if (error instanceof OAuthConformanceSessionNotFoundError) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, error.message);
  }
  if (error instanceof OAuthConformanceSessionFailedError) {
    return new WebRouteError(500, ErrorCode.INTERNAL_ERROR, error.message);
  }
  return new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : "Unknown error",
  );
}

// ── POST /protocol ──────────────────────────────────────────────────────

conformanceWeb.post("/protocol", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(bearerToken, body);

    try {
      const { result } = await runProtocolConformance(resolved);
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  }),
);

// ── POST /apps ──────────────────────────────────────────────────────────

conformanceWeb.post("/apps", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const config = await resolveHostedServerConfig(bearerToken, body);

    try {
      const { result } = await runAppsConformance(config);
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  }),
);

// ── POST /oauth/start ───────────────────────────────────────────────────

const oauthStartSchema = z
  .object({
    oauthProfile: oauthConformanceProfileSchema.optional(),
    runNegativeChecks: z.boolean().optional(),
    callbackOrigin: z.string().optional(),
  })
  .passthrough(); // workspace/guest fields pass through to resolveHostedHttpConfig

conformanceWeb.post("/oauth/start", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(bearerToken, body);
    const parsed = parseWithSchema(oauthStartSchema, body);

    if (!parsed.callbackOrigin) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "callbackOrigin is required to run OAuth conformance",
      );
    }

    try {
      return await startOAuthConformance({
        defaultServerUrl: resolved.serverUrl,
        defaultCustomHeaders: resolved.customHeaders,
        redirectUrl: `${parsed.callbackOrigin.replace(/\/$/, "")}/oauth/callback/debug`,
        oauthProfile: parsed.oauthProfile,
        runNegativeChecks: parsed.runNegativeChecks,
      });
    } catch (error) {
      throw toWebError(error);
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

    const delivered = submitOAuthConformanceCode(parsed);
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
    try {
      return await completeOAuthConformance(parsed);
    } catch (error) {
      throw toWebError(error);
    }
  }),
);

export default conformanceWeb;
