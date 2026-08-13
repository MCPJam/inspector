import type { UnauthorizedRefreshHandler } from "@mcpjam/sdk";
import type { OAuthTokens } from "@modelcontextprotocol/client";
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";
import {
  refreshTokensAgainstPrivateAuthorizationServer,
  type PrivateAuthorizationServerRefreshMaterial,
} from "./local-oauth-refresh.js";
import { logger } from "./logger.js";

/**
 * The backend cannot refresh this credential — its authorization server is on
 * an address only this machine can reach — and handed back what is needed to
 * do it here.
 *
 * The material rides on a PLAIN PROPERTY, deliberately NOT in `details`.
 * `respondWithLocalRouteError` spreads `details` top-level into the HTTP
 * response body, so a refresh token in there would be handed to the browser on
 * any path where this error escapes uncaught. On that path this degrades to a
 * bare 409 with no secret in it. Keep it out of `details`.
 */
export class PrivateAuthorizationServerRefreshError extends WebRouteError {
  readonly refreshMaterial: PrivateAuthorizationServerRefreshMaterial | null;

  constructor(
    status: number,
    message: string,
    refreshMaterial: PrivateAuthorizationServerRefreshMaterial | null,
    details?: Record<string, unknown>
  ) {
    super(status, ErrorCode.CONFLICT, message, details);
    this.name = "PrivateAuthorizationServerRefreshError";
    this.refreshMaterial = refreshMaterial;
  }
}

function parseRefreshMaterial(
  value: unknown
): PrivateAuthorizationServerRefreshMaterial | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const authorizationServerUrl = raw.authorizationServerUrl;
  const serverUrl = raw.serverUrl;
  const clientId = raw.clientId;
  const refreshToken = raw.refreshToken;
  if (
    typeof authorizationServerUrl !== "string" ||
    typeof serverUrl !== "string" ||
    typeof clientId !== "string" ||
    typeof refreshToken !== "string"
  ) {
    return null;
  }
  return {
    authorizationServerUrl,
    serverUrl,
    oauthResourceUrl:
      typeof raw.oauthResourceUrl === "string" ? raw.oauthResourceUrl : null,
    clientId,
    ...(typeof raw.clientSecret === "string"
      ? { clientSecret: raw.clientSecret }
      : {}),
    refreshToken,
  };
}

export type HostedOAuthRefreshOptions = {
  accessScope?: "project_member" | "chat_v2";
  shareToken?: string;
  /**
   * Resolved chatbox identity (post-redeem). The backend scopes OAuth
   * credentials by `(userId, chatbox.projectId, serverId)` from this; no
   * link token is forwarded on refresh.
   */
  chatboxId?: string;
  accessVersion?: number;
  serverName?: string;
};

/**
 * POST `/web/oauth/force-refresh` against Convex with the user's WorkOS
 * bearer to mint a fresh hosted-OAuth access token. Used by both the hosted
 * `/web` routes and the local `/mcp` resolver — they call the same backend
 * endpoint with the same bearer the rest of their flow already uses.
 *
 * Throws a `WebRouteError`. When the backend reports `refresh_token_invalid`,
 * the error's `details.refreshTokenInvalid` is set so the surrounding UI can
 * prompt a real reconnect instead of a generic failure.
 */
export async function forceRefreshHostedOAuthAccessToken(
  bearerToken: string,
  projectId: string,
  serverId: string,
  options?: HostedOAuthRefreshOptions
): Promise<string> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/oauth/force-refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        projectId,
        serverId,
        ...(options?.accessScope ? { accessScope: options.accessScope } : {}),
        ...(options?.shareToken ? { shareToken: options.shareToken } : {}),
        ...(options?.chatboxId ? { chatboxId: options.chatboxId } : {}),
        ...(options?.chatboxId && Number.isFinite(options?.accessVersion)
          ? { accessVersion: options.accessVersion }
          : {}),
      }),
    });
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Failed to reach OAuth refresh service: ${parseErrorMessage(error)}`
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code =
      typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `OAuth refresh failed (${response.status})`;
    // The backend's 409: the credential is fine, but its authorization server
    // is on an address the cloud cannot reach. Typed so the local caller can
    // take over the refresh instead of failing the connect; an un-upgraded
    // caller still gets the backend's message, which stands on its own.
    if (code === "private_authorization_server") {
      throw new PrivateAuthorizationServerRefreshError(
        response.status,
        message,
        parseRefreshMaterial(body?.refresh),
        { serverId, serverName: options?.serverName ?? null }
      );
    }
    const isReconnectRequired = code === "refresh_token_invalid";
    // The backend's 503: the credential is fine, the authorization server
    // never answered usably. Its `detail` is what that server actually
    // returned ({url, status, body}) — forwarded so the client can name the
    // host instead of guessing, null when the backend recorded nothing.
    const isAuthServerUnreachable = code === "authorization_server_unreachable";
    throw new WebRouteError(
      response.status,
      isReconnectRequired ? ErrorCode.UNAUTHORIZED : (code as ErrorCode),
      message,
      isReconnectRequired
        ? {
            oauthRequired: true,
            refreshTokenInvalid: true,
            serverId,
            serverName: options?.serverName ?? null,
          }
        : isAuthServerUnreachable
        ? {
            authorizationServerUnreachable: true,
            serverId,
            serverName: options?.serverName ?? null,
            failure: body?.detail ?? null,
          }
        : undefined
    );
  }

  const accessToken =
    typeof body?.accessToken === "string" ? body.accessToken.trim() : "";
  if (!accessToken) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "OAuth refresh service returned an invalid access token"
    );
  }

  return accessToken;
}

/**
 * Push locally-refreshed tokens back into the backend so the next connect —
 * from anywhere — finds them. Same endpoint the OAuth flow already uses to
 * import tokens; the AS URL rides along because the backend cannot rediscover
 * it against an address it can't reach.
 */
async function importRefreshedTokens(
  bearerToken: string,
  projectId: string,
  serverId: string,
  material: PrivateAuthorizationServerRefreshMaterial,
  tokens: OAuthTokens
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) return;

  const response = await fetch(`${convexUrl}/web/oauth/import-tokens`, {
    method: "POST",
    // Bounded: a Convex that accepts the connection but never answers would
    // otherwise hang the connect that already holds a working token. A
    // timeout lands in the caller's warning path, which is the right outcome.
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      projectId,
      serverId,
      serverUrl: material.serverUrl,
      ...(material.oauthResourceUrl
        ? { oauthResourceUrl: material.oauthResourceUrl }
        : {}),
      authorizationServerUrl: material.authorizationServerUrl,
      kind: "generic",
      clientInformation: {
        clientId: material.clientId,
        ...(material.clientSecret
          ? { clientSecret: material.clientSecret }
          : {}),
      },
      tokens,
    }),
  });

  if (!response.ok) {
    throw new Error(`import-tokens responded ${response.status}`);
  }
}

/**
 * `forceRefreshHostedOAuthAccessToken`, plus the one thing the backend cannot
 * do for itself: when the authorization server is on a private address, refresh
 * it HERE and push the result back.
 *
 * A sibling rather than a widened return type on the base function. Its three
 * callers all want a bare access token, and two of them (the `discover` rung,
 * the hosted `onUnauthorized`) are on paths that must never grow a branch they
 * cannot take.
 */
export async function refreshHostedOAuthAccessTokenWithLocalFallback(
  bearerToken: string,
  projectId: string,
  serverId: string,
  options?: HostedOAuthRefreshOptions
): Promise<string> {
  try {
    return await forceRefreshHostedOAuthAccessToken(
      bearerToken,
      projectId,
      serverId,
      options
    );
  } catch (error) {
    if (!(error instanceof PrivateAuthorizationServerRefreshError)) {
      throw error;
    }
    if (!error.refreshMaterial) {
      // Backend withheld it — a shared credential, or a browser-shaped caller.
      // Nothing to do here; the message explains the fix.
      throw error;
    }

    let tokens: OAuthTokens;
    try {
      tokens = await refreshTokensAgainstPrivateAuthorizationServer(
        error.refreshMaterial
      );
    } catch (refreshError) {
      throw translateLocalRefreshFailure(
        refreshError,
        error.refreshMaterial,
        serverId,
        options?.serverName ?? null
      );
    }

    const accessToken = tokens.access_token?.trim();
    if (!accessToken) {
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "The authorization server returned no access token"
      );
    }

    try {
      await importRefreshedTokens(
        bearerToken,
        projectId,
        serverId,
        error.refreshMaterial,
        tokens
      );
    } catch (importError) {
      // THIS connect succeeds — the token in hand is good. But if the
      // authorization server rotated the refresh token, the stored one is now
      // dead and the next connect will see invalid_grant, clear, and prompt a
      // reconnect. Recoverable and signposted, and strictly better than also
      // failing the connect that already has a working token.
      logger.warn(
        "[local oauth refresh] refreshed locally but could not store the result",
        {
          serverId,
          rotatedRefreshToken: Boolean(tokens.refresh_token),
          error: parseErrorMessage(importError),
        }
      );
    }

    return accessToken;
  }
}

/**
 * Map a local-refresh failure onto the shapes the surrounding code already
 * knows, so the UX matches a backend refresh failing the same way.
 */
function translateLocalRefreshFailure(
  error: unknown,
  material: PrivateAuthorizationServerRefreshMaterial,
  serverId: string,
  serverName: string | null
): WebRouteError {
  const message = parseErrorMessage(error);

  // Two carriers for one OAuth code, both required. A conforming RFC 6749 §5.2
  // decline arrives as the SDK's OAuthResponseError with the code on `.code`
  // and the error_description in `message` — so matching the message alone
  // misses the COMMON case. Non-conforming servers only put it in the text.
  const oauthCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";

  // The authorization server rejected the grant. Same shape the backend sends
  // for refresh_token_invalid, so the existing reconnect prompt just works.
  if (
    /^(invalid_grant|invalid_client)$/i.test(oauthCode) ||
    /invalid_grant|invalid_client/i.test(message)
  ) {
    return new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "The stored refresh token was rejected. Please reconnect.",
      { oauthRequired: true, refreshTokenInvalid: true, serverId, serverName }
    );
  }

  // Their own server isn't running. The connect was going to fail regardless;
  // say why rather than reporting a generic refresh error.
  return new WebRouteError(
    502,
    ErrorCode.SERVER_UNREACHABLE,
    `Could not reach the authorization server at ${material.authorizationServerUrl}: ${message}`,
    { serverId, serverName }
  );
}

export type HostedOAuthUnauthorizedHandlerArgs = {
  bearerToken: string;
  projectId: string;
  serverId: string;
  serverName: string;
  accessScope?: "project_member" | "chat_v2";
  shareToken?: string;
  chatboxId?: string;
  accessVersion?: number;
  /**
   * Allow refreshing a private authorization server locally when the backend
   * reports it cannot. Set ONLY by the local `/mcp` resolver — this builder is
   * shared with the hosted `/web` routes, where there is no user machine to
   * reach a private address from. Belt and braces with the `HOSTED_MODE`
   * assertion inside `local-oauth-refresh`: a call-site flag so hosted cannot
   * opt in by accident, and a process constant so a mistaken flag still cannot
   * dial a private address from production.
   */
  allowPrivateAuthorizationServerFallback?: boolean;
};

/**
 * Build the `onUnauthorized` callback used by the SDK's 401-retry path. The
 * handler closes over the routing context (bearer/project/server identity and
 * scope) so the SDK only has to invoke `({serverId, error}) => Promise<{accessToken}>`
 * without knowing how refresh actually happens.
 */
export function buildHostedOAuthUnauthorizedHandler(
  args: HostedOAuthUnauthorizedHandlerArgs
): UnauthorizedRefreshHandler {
  const refresh = args.allowPrivateAuthorizationServerFallback
    ? refreshHostedOAuthAccessTokenWithLocalFallback
    : forceRefreshHostedOAuthAccessToken;
  return async () => ({
    accessToken: await refresh(
      args.bearerToken,
      args.projectId,
      args.serverId,
      {
        accessScope: args.accessScope,
        shareToken: args.shareToken,
        chatboxId: args.chatboxId,
        accessVersion: args.accessVersion,
        serverName: args.serverName,
      }
    ),
  });
}
