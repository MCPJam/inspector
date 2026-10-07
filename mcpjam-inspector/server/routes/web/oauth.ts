import { Hono } from "hono";
import type { Context } from "hono";
import { describeError } from "@mcpjam/sdk";
import {
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";
import {
  assertBearerToken,
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webErrorFromRoute,
} from "./errors.js";
import { fetchRuntimeServerSecrets } from "../../utils/server-secrets.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import { passthroughRateLimitMiddleware } from "../../middleware/passthrough-rate-limit.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { classifyError } from "../../utils/error-classify.js";
import {
  prepareHostedOAuthProxyRequest,
  projectHostedOAuthMetadata,
  projectHostedOAuthProxyResponse,
} from "../../utils/hosted-oauth-proxy.js";
import { boundText } from "../../utils/hosted-upstream-projection.js";

const oauthWeb = new Hono();
const OAUTH_UPSTREAM_URL_HEADER = "X-MCPJam-OAuth-Upstream-URL";
const LOCAL_RECOVERY_TTL_MS = 15 * 60 * 1000;
const LOCAL_RECOVERY_MAX_RECORDS = 128;
const LOCAL_RECOVERY_MAX_HEADER_BYTES = 64 * 1024;
const localRecoveryHeaders = new Map<
  string,
  { expiresAt: number; headers: Record<string, string> }
>();

function evictExpiredLocalRecoveryHeaders(now = Date.now()): void {
  for (const [key, record] of localRecoveryHeaders) {
    if (record.expiresAt <= now) localRecoveryHeaders.delete(key);
  }
}

function localRecoveryPrincipal(c: Context): string {
  const guestId = c.get("guestId");
  if (typeof guestId === "string" && guestId) return `guest:${guestId}`;
  const workosUserId = c.get("workosUserId");
  if (typeof workosUserId === "string" && workosUserId) {
    return `workos:${workosUserId}`;
  }
  const workosApiKeyId = c.get("workosApiKeyId");
  if (typeof workosApiKeyId === "string" && workosApiKeyId) {
    return `api-key:${workosApiKeyId}`;
  }
  // Legacy local clients use passthrough bearer tokens. The high-entropy,
  // single-use recovery handle remains the capability in that case.
  return "unverified-passthrough";
}

function parseRecoveryHandle(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value)
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Missing or invalid OAuth recovery handle",
    );
  }
  return value;
}

function localRecoveryKey(input: {
  principal: string;
  recoveryHandle: string;
  serverName: string;
  serverUrl: string;
}): string {
  return [
    input.principal,
    input.recoveryHandle,
    input.serverName,
    input.serverUrl,
  ].join("\0");
}

function omitAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
}

function parseRecoveryHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(
    ([key, headerValue]) =>
      key.trim().length > 0 &&
      key.length <= 256 &&
      typeof headerValue === "string" &&
      headerValue.length <= 8192,
  );
  if (entries.length > 64) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Too many OAuth recovery headers",
    );
  }
  const totalBytes = entries.reduce(
    (sum, [key, headerValue]) =>
      sum + Buffer.byteLength(key) + Buffer.byteLength(headerValue),
    0,
  );
  if (totalBytes > LOCAL_RECOVERY_MAX_HEADER_BYTES) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "OAuth recovery headers are too large",
    );
  }
  return Object.fromEntries(entries);
}

function safeHostname(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// Require some form of bearer token (guest or WorkOS) on all OAuth proxy routes
oauthWeb.use("*", bearerAuthMiddleware);

// Rate limit guest users on OAuth proxy routes
oauthWeb.use("*", guestRateLimitMiddleware);

// MJ-012: signed-in callers. Mounted here, not only on `/api/web`, because
// that `*` limiter runs before this router sets `authMethod`.
oauthWeb.use("*", passthroughRateLimitMiddleware);

function statusToErrorCode(status: number): ErrorCode {
  if (status === 400) return ErrorCode.VALIDATION_ERROR;
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status === 502) return ErrorCode.SERVER_UNREACHABLE;
  if (status === 504) return ErrorCode.TIMEOUT;
  return ErrorCode.INTERNAL_ERROR;
}

function webErrorCompat(c: Context, routeError: WebRouteError) {
  // Through `webErrorFromRoute`, NOT a hand-rolled `c.json`. The hand-rolled
  // version never set `webErrorMeta`, so `requestLogContextMiddleware` had
  // nothing to read: every failure on these routes logged as a bare
  // `internal_error` with no message, no slug, and no origin. Measured on
  // 2026-08-15 as 55 rows in 72h on `/api/web/oauth/metadata` alone — the
  // single largest unattributed class on the whole surface, and structurally
  // invisible to the MCPJam-fault monitor.
  //
  // TODO(hosted-v1.1): Remove `error` once clients migrate to `{ code, message }`.
  // This compatibility key exists for one release to avoid breaking callers that
  // still parse legacy `{ error }` payloads on oauth routes. It rides as an
  // `extras` key, which `webError` spreads into the body ahead of the canonical
  // fields, so the wire shape is unchanged apart from the additions every other
  // `/api/web/*` envelope already carries.
  return webErrorFromRoute(c, routeError, { error: routeError.message });
}

function toRouteError(error: unknown): WebRouteError {
  // Everything goes through `mapRuntimeError`, including errors that already
  // ARE a `WebRouteError`. It backfills `normalized` and resolves the effective
  // `origin`, and `webError` reports neither field unless `normalized` exists —
  // so returning a hand-built `WebRouteError` unclassified, as both branches
  // below used to, produced an envelope and a log row with no attribution at
  // all. It never overrules an origin that is already set.
  //
  // NOTE: no `mcpjam_internal` boundary anywhere on this route, deliberately.
  // These handlers reach the USER's authorization server — an unreachable
  // `.well-known`, a refused connection, or a wrong issuer is theirs, and
  // declaring an internal hop here would page us for exactly the class of
  // third-party outage this program exists to stop paging on.
  if (error instanceof OAuthProxyError) {
    return mapRuntimeError(
      new WebRouteError(
        error.status,
        statusToErrorCode(error.status),
        error.message,
        undefined,
        // Classify from the ORIGINAL, which carries `.status`. Describing the
        // rebuilt `WebRouteError` instead would leave the describer nothing but
        // a message string to pattern-match.
        describeError(error),
      ),
    );
  }
  return mapRuntimeError(error);
}

function getConvexHttpUrl(): string {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }

  return convexUrl;
}

async function proxyConvexOAuthPost(c: Context, path: string) {
  const convexUrl = getConvexHttpUrl();
  const authorization = c.req.header("authorization");
  const payload = await c.req.json();
  const response = await fetch(`${convexUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  return new Response(bodyText, {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}

/**
 * Proxy OAuth token exchange and client registration requests.
 * POST /api/web/oauth/proxy
 *
 * Mirrors /api/mcp/oauth/proxy with HTTPS-only + private IP blocking.
 * Body: { url: string, method?: "GET" | "POST", body?: object, headers?: object }
 *
 * The request and the answer go through `hosted-oauth-proxy` (MJ-001): GET or
 * POST only, connection and cookie headers dropped, and the answer reduced to
 * its status, the headers the OAuth flows read, and a JSON or form-encoded
 * body.
 */
oauthWeb.post("/proxy", async (c) => {
  let proxyUrl: string | undefined;
  try {
    const { url, method, body, headers } = await c.req.json();
    proxyUrl = url;
    const request = prepareHostedOAuthProxyRequest({ method, headers });
    const result = await executeOAuthProxy({
      url,
      method: request.method,
      body,
      headers: request.headers,
      httpsOnly: true,
    });
    c.header(OAUTH_UPSTREAM_URL_HEADER, result.finalUrl);
    return c.json(projectHostedOAuthProxyResponse(result));
  } catch (error) {
    getRequestLogger(c, "routes.web.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost: safeHostname(proxyUrl),
      oauthPhase: "proxy",
      errorCode: classifyError(error),
      ...(error instanceof OAuthProxyError ? { statusCode: error.status } : {}),
    });
    return webErrorCompat(c, toRouteError(error));
  }
});

/**
 * Proxy OAuth metadata discovery requests.
 * GET /api/web/oauth/metadata?url=https://...
 *
 * Mirrors /api/mcp/oauth/metadata with HTTPS-only + private IP blocking. The
 * document is returned as a re-serialized JSON object within the hosted body
 * cap (MJ-001).
 */
oauthWeb.get("/metadata", async (c) => {
  const metadataUrl = c.req.query("url");
  try {
    if (!metadataUrl) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Missing url parameter",
      );
    }

    const result = await fetchOAuthMetadata(metadataUrl, true);
    if ("status" in result && result.status !== undefined) {
      const statusText = boundText(result.statusText, 128);
      throw new WebRouteError(
        result.status,
        statusToErrorCode(result.status),
        `Failed to fetch OAuth metadata: ${result.status}${
          statusText ? ` ${statusText}` : ""
        }`,
      );
    }

    const metadata = projectHostedOAuthMetadata(result.metadata);
    c.header(OAUTH_UPSTREAM_URL_HEADER, result.finalUrl);
    return c.json(metadata);
  } catch (error) {
    getRequestLogger(c, "routes.web.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost: safeHostname(metadataUrl),
      oauthPhase: "metadata",
      errorCode: classifyError(error),
      ...(error instanceof OAuthProxyError ? { statusCode: error.status } : {}),
    });
    return webErrorCompat(c, toRouteError(error));
  }
});

// Pure pass-through proxies to the matching Convex /web/oauth/* endpoints.
// Each handler is identical apart from the path, so register them in a loop
// rather than copy-pasting the try/catch shell four times.
const CONVEX_OAUTH_PROXY_PATHS = [
  "session",
  "tokens",
  "import-tokens",
  "client-secret",
] as const;

for (const path of CONVEX_OAUTH_PROXY_PATHS) {
  oauthWeb.post(`/${path}`, async (c) => {
    try {
      return await proxyConvexOAuthPost(c, `/web/oauth/${path}`);
    } catch (error) {
      return webErrorCompat(c, toRouteError(error));
    }
  });
}

/**
 * Recover callback-only OAuth headers from the encrypted server-secret store.
 * Values are returned to the initiating browser for this exchange only and are
 * never written to browser storage. The backend verifies that the credential
 * binding permits the requested server URL.
 */
oauthWeb.post("/recovery-headers", async (c) => {
  try {
    const bearerToken = assertBearerToken(c);
    const body = await c.req.json();
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const serverId = typeof body?.serverId === "string" ? body.serverId : "";
    const serverName =
      typeof body?.serverName === "string" ? body.serverName : "";
    const serverUrl = typeof body?.serverUrl === "string" ? body.serverUrl : "";
    if (!serverName || !serverUrl) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Missing OAuth recovery binding",
      );
    }
    if (projectId && serverId) {
      const secrets = await fetchRuntimeServerSecrets({
        bearerToken,
        projectId,
        serverId,
        expectedTargetUrl: serverUrl,
        accessScope: "project_member",
      });
      return c.json({
        success: true,
        headers: omitAuthorizationHeader(secrets.headers),
      });
    }
    const recoveryHandle = parseRecoveryHandle(body?.recoveryHandle);
    evictExpiredLocalRecoveryHeaders();
    const key = localRecoveryKey({
      principal: localRecoveryPrincipal(c),
      recoveryHandle,
      serverName,
      serverUrl,
    });
    const staged = localRecoveryHeaders.get(key);
    localRecoveryHeaders.delete(key);
    if (!staged || staged.expiresAt <= Date.now()) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "OAuth recovery headers are no longer available",
      );
    }
    return c.json({
      success: true,
      headers: omitAuthorizationHeader(staged.headers),
    });
  } catch (error) {
    return webErrorCompat(c, toRouteError(error));
  }
});

oauthWeb.post("/recovery-headers/stage", async (c) => {
  try {
    const body = await c.req.json();
    const serverName =
      typeof body?.serverName === "string" ? body.serverName : "";
    const serverUrl = typeof body?.serverUrl === "string" ? body.serverUrl : "";
    const recoveryHandle = parseRecoveryHandle(body?.recoveryHandle);
    const headers = parseRecoveryHeaders(body?.headers);
    if (!serverName || !serverUrl || Object.keys(headers).length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Missing OAuth recovery headers",
      );
    }
    evictExpiredLocalRecoveryHeaders();
    const key = localRecoveryKey({
      principal: localRecoveryPrincipal(c),
      recoveryHandle,
      serverName,
      serverUrl,
    });
    if (
      !localRecoveryHeaders.has(key) &&
      localRecoveryHeaders.size >= LOCAL_RECOVERY_MAX_RECORDS
    ) {
      throw new WebRouteError(
        429,
        ErrorCode.RATE_LIMITED,
        "Too many pending OAuth recovery records",
      );
    }
    localRecoveryHeaders.set(key, {
      expiresAt: Date.now() + LOCAL_RECOVERY_TTL_MS,
      headers,
    });
    return c.json({ success: true });
  } catch (error) {
    return webErrorCompat(c, toRouteError(error));
  }
});

// Local-mode token import — see backend `/web/oauth/import-tokens` for shape.
// The local CLI's `MCPOAuthProvider` uses this to push browser-side
// PKCE-exchanged tokens into Convex so the resolver can read them.
oauthWeb.post("/import-tokens", async (c) => {
  try {
    return await proxyConvexOAuthPost(c, "/web/oauth/import-tokens");
  } catch (error) {
    return webErrorCompat(c, toRouteError(error));
  }
});

/**
 * Debug proxy for OAuth flow visualization (hosted mode).
 * POST /api/web/oauth/debug/proxy
 *
 * Mirrors /api/mcp/oauth/debug/proxy with HTTPS-only + private IP blocking.
 * Body: { url: string, method?: "GET" | "POST", body?: object, headers?: object }
 *
 * Same request and answer rules as `/proxy` (MJ-001); an event-stream answer
 * from an MCP server keeps its JSON events.
 */
oauthWeb.post("/debug/proxy", async (c) => {
  let proxyUrl: string | undefined;
  try {
    const { url, method, body, headers } = await c.req.json();
    proxyUrl = url;
    const request = prepareHostedOAuthProxyRequest({ method, headers });
    // Note: no `redirect` option here — this route is always httpsOnly, and the
    // SDK proxy forces `redirect: "manual"` under httpsOnly, so passing one
    // would be dead code. The mcp route (not httpsOnly) is where it applies.
    const result = await executeDebugOAuthProxy({
      url,
      method: request.method,
      body,
      headers: request.headers,
      httpsOnly: true,
    });
    return c.json(
      projectHostedOAuthProxyResponse(result, { eventStreams: true }),
    );
  } catch (error) {
    getRequestLogger(c, "routes.web.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost: safeHostname(proxyUrl),
      oauthPhase: "proxy",
      errorCode: classifyError(error),
      ...(error instanceof OAuthProxyError ? { statusCode: error.status } : {}),
    });
    return webErrorCompat(c, toRouteError(error));
  }
});

export default oauthWeb;
