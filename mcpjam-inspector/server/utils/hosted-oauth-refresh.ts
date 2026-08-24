import { createHash } from "node:crypto";
import type { UnauthorizedRefreshHandler } from "@mcpjam/sdk";
import type { OAuthTokens } from "@modelcontextprotocol/client";
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";
import { HOSTED_MODE } from "../config.js";
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

/**
 * What each private-authorization-server credential needs to refresh itself,
 * keyed by `projectId:serverId` and kept current with the token in effect.
 *
 * Exists so the local fallback does not depend on the backend answering. The
 * force-refresh budget is 10/min per subject and server, every fallback spends
 * one on a call that structurally cannot succeed, and once it is empty the
 * backend returns a plain 429 — locking the user out of a refresh that needs
 * nothing from the backend.
 *
 * In-memory and process-local, never persisted, and it only ever populates on
 * a non-hosted process: the write happens after a successful local refresh,
 * and `refreshTokensAgainstPrivateAuthorizationServer` throws on `HOSTED_MODE`
 * before dialing. A hosted replica therefore holds nothing here, and
 * `declareLocalRuntime: !HOSTED_MODE` means the backend would withhold the
 * material anyway. Horizontal hosted deployments see no behaviour change.
 *
 * Process-local is NOT single-owner, though. Two local inspectors (desktop and
 * `npx`), or several replicas of a self-hosted non-hosted-mode deployment,
 * share one backend credential while each keeps its own copy of this map — so
 * an entry can be superseded by a refresh this process never saw. Treat a
 * cache hit as a guess: `cachedMaterialFallback` below is what keeps a stale
 * guess from being reported as a dead credential.
 *
 * Keyed by SUBJECT as well as project and server. NOT because one process
 * serves several users concurrently — a non-hosted process binds to 127.0.0.1
 * and only serves its session token to localhost. Because one process outlives
 * one signed-in user: sign out, sign in as someone else with access to the
 * same project, and a `projectId:serverId` key hands the second user the
 * first's cached refresh token, after which `importRefreshedTokens` writes the
 * rotated result into the second user's credential. The bearer is hashed,
 * never stored: a rotated bearer simply misses and falls back to the backend,
 * which is the safe direction.
 */
const privateAuthorizationServerMaterialCache = new Map<
  string,
  PrivateAuthorizationServerRefreshMaterial
>();

/**
 * Which caller a cache entry belongs to, without keeping the bearer around.
 *
 * Truncated to 128 bits: this only has to separate subjects within one
 * process, and a shorter key keeps the map readable in a heap dump.
 */
function subjectFingerprint(bearerToken: string): string {
  return createHash("sha256").update(bearerToken).digest("hex").slice(0, 32);
}

/**
 * Did the backend fail to REACH a verdict, rather than reach one we dislike?
 *
 * Only these may fall through to the cached material. Everything else — most
 * sharply the 401 the backend sends for `refresh_token_invalid`, but equally a
 * 403 or a 404 — is a decision about this caller's access, and honouring the
 * cache past it would keep a revoked connection alive.
 *
 * 409 is deliberately absent: `refresh_in_progress` means another refresh
 * holds the lease right now, and refreshing anyway would race it and rotate
 * the token out from under the holder. That one wants a retry, not a cache.
 */
function isUninformativeBackendFailure(error: unknown): boolean {
  if (!(error instanceof WebRouteError)) return false;
  return (
    error.status === 429 || // force-refresh budget spent
    error.status === 502 || // could not reach the backend at all
    error.status === 503 || // backend up, authorization server never answered
    error.status === 504
  );
}

/** Test seam: nothing outside tests should need to reach into the cache. */
export function __resetPrivateAuthorizationServerMaterialCacheForTests(): void {
  privateAuthorizationServerMaterialCache.clear();
}

export type HostedOAuthRefreshOptions = {
  accessScope?: "project_member" | "chat_v2";
  shareToken?: string;
  /**
   * Resolved scenario identity (post-redeem). The backend scopes OAuth
   * credentials by `(userId, scenario.projectId, serverId)` from this; no
   * link token is forwarded on refresh.
   */
  scenarioId?: string;
  accessVersion?: number;
  serverName?: string;
  /**
   * Tell the backend this process runs on the user's own machine, so it may
   * hand back the material to refresh an authorization server it cannot reach
   * itself. Without it the 409 arrives with no `refresh` and the local
   * fallback has nothing to work with.
   *
   * Set only by `refreshHostedOAuthAccessTokenWithLocalFallback`, and only
   * when this really is the local binary.
   */
  declareLocalRuntime?: boolean;
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
        ...(options?.scenarioId ? { scenarioId: options.scenarioId } : {}),
        ...(options?.scenarioId && Number.isFinite(options?.accessVersion)
          ? { accessVersion: options.accessVersion }
          : {}),
        ...(options?.declareLocalRuntime ? { localRuntime: true } : {}),
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
  const cacheKey = `${subjectFingerprint(bearerToken)}:${projectId}:${serverId}`;
  let material: PrivateAuthorizationServerRefreshMaterial | null = null;
  // Material read back from the cache is a GUESS about a credential this
  // process does not own — see the failure handling below.
  let cachedMaterialFallback: { backendError: unknown } | null = null;

  try {
    return await forceRefreshHostedOAuthAccessToken(
      bearerToken,
      projectId,
      serverId,
      // The declaration is what makes the backend willing to hand back the
      // refresh material at all. Gated on the process, not just the call site:
      // a hosted deployment reaching this function by mistake must not ask for
      // a secret it could never use.
      { ...options, declareLocalRuntime: !HOSTED_MODE }
    );
  } catch (error) {
    if (error instanceof PrivateAuthorizationServerRefreshError) {
      if (!error.refreshMaterial) {
        // Backend withheld it — a shared credential, a browser-shaped caller,
        // or no authorization server URL was ever stored. Nothing to do here;
        // the message explains the fix.
        throw error;
      }
      material = error.refreshMaterial;
    } else if (isUninformativeBackendFailure(error)) {
      // The backend could not ANSWER — as opposed to answering "no". This
      // server may already be known to need a local refresh, in which case the
      // backend has nothing to contribute and a verdict it never reached
      // should not block us.
      //
      // The concrete case is the force-refresh rate limit (10/min per
      // subject:serverId). Every local fallback first spends a token from that
      // budget on a call that structurally cannot succeed, so a chatty session
      // against a flapping localhost server empties it, the backend starts
      // answering 429 before it ever reaches the private-address resolution,
      // and the user is locked out of a refresh that needs nothing from the
      // backend at all.
      material = privateAuthorizationServerMaterialCache.get(cacheKey) ?? null;
      if (!material) {
        throw error;
      }
      cachedMaterialFallback = { backendError: error };
      logger.debug(
        "[local oauth refresh] backend refresh unavailable; using cached private-AS material",
        { serverId, error: parseErrorMessage(error) }
      );
    } else {
      // The backend answered, and the answer was no. A 401 (bearer expired),
      // 403 (membership revoked) or 404 (the user pressed Disconnect) is a
      // decision about whether this caller may still use this credential at
      // all — and the cached refresh token would happily mint a working access
      // token past every one of them. Serving those from cache made revoking
      // a connection in the UI a no-op until the process restarted.
      throw error;
    }
  }

  let tokens: OAuthTokens;
  try {
    tokens = await refreshTokensAgainstPrivateAuthorizationServer(material);
  } catch (refreshError) {
    if (isRejectedGrant(refreshError)) {
      // The cached token is dead; never replay it.
      privateAuthorizationServerMaterialCache.delete(cacheKey);

      // ...and if that is ALL we had, do not tell the user to reconnect.
      //
      // This cache is per process, but the credential is not. A second local
      // inspector, or another replica of a self-hosted deployment, may have
      // refreshed the same credential and rotated the refresh token out from
      // under this copy — in which case the vault holds a perfectly good token
      // and only OUR guess is stale. Reporting "the stored refresh token was
      // rejected. Please reconnect." would send someone to re-run an OAuth
      // flow they do not need.
      //
      // Only material handed over by the backend moments ago is authoritative
      // enough to say that. Surface the backend's own error instead: it is
      // why we fell back at all, it is honest, and it is transient — the next
      // attempt gets fresh material and either succeeds or earns a real
      // reconnect prompt.
      if (cachedMaterialFallback) {
        logger.debug(
          "[local oauth refresh] cached private-AS material was stale; deferring to the backend error",
          { serverId, error: parseErrorMessage(refreshError) }
        );
        throw cachedMaterialFallback.backendError;
      }
    }
    throw translateLocalRefreshFailure(
      refreshError,
      material,
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

  // The SDK's `refreshAuthorization` already spreads the response over the
  // refresh token it was given, so an authorization server that omits one
  // (RFC 6749 §6, meaning "keep using the one you have" — and many do) keeps
  // working. It does NOT cover an explicit `refresh_token: null`, which the
  // spread would write straight through and leave a credential that fails its
  // very next expiry with "missing refresh_token".
  const tokensToStore: OAuthTokens = tokens.refresh_token?.trim()
    ? tokens
    : { ...tokens, refresh_token: material.refreshToken };

  // Remember what this server needs, keyed to the token now in effect, so the
  // next expiry can refresh without spending backend budget on a call that
  // cannot succeed.
  privateAuthorizationServerMaterialCache.set(cacheKey, {
    ...material,
    refreshToken: tokensToStore.refresh_token ?? material.refreshToken,
  });

  try {
    await importRefreshedTokens(
      bearerToken,
      projectId,
      serverId,
      material,
      tokensToStore
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

/** Did the authorization server itself reject the grant? */
function isRejectedGrant(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return /^(invalid_grant|invalid_client)$/i.test(code);
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
  //
  // The message arm covers a server that puts the code only in its
  // error_description, but it must never read text the SERVER did not author
  // as OAuth. When the response was not JSON at all, the SDK embeds the raw
  // body verbatim (`Invalid OAuth error response: ${body}`) — so a dev proxy's
  // HTML error page that merely mentions `invalid_grant` turned a transport
  // problem into "your refresh token was rejected, please reconnect", on a
  // credential that was fine. Cut the message at that marker before matching.
  //
  // Word-bounded for a second false positive: `invalid_client` is a substring
  // of the unrelated `invalid_client_metadata`.
  const authoredMessage = message.split("Invalid OAuth error response:")[0];
  if (
    /^(invalid_grant|invalid_client)$/i.test(oauthCode) ||
    /\b(invalid_grant|invalid_client)\b/i.test(authoredMessage)
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
  //
  // Origin only, never the raw URL — the same rule
  // `refreshTokensAgainstPrivateAuthorizationServer` applies to its debug log,
  // and it binds harder here: this message is the HTTP response body and it
  // reaches Sentry. An imported authorization-server URL can carry basic-auth
  // userinfo or an `x-api-key`-style query parameter, and `.origin` drops
  // userinfo, path and query while keeping the host the user needs to see.
  let authorizationServerOrigin: string;
  try {
    authorizationServerOrigin = new URL(material.authorizationServerUrl).origin;
  } catch {
    authorizationServerOrigin = "the authorization server";
  }
  return new WebRouteError(
    502,
    ErrorCode.SERVER_UNREACHABLE,
    `Could not reach the authorization server at ${authorizationServerOrigin}: ${message}`,
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
  scenarioId?: string;
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
        scenarioId: args.scenarioId,
        accessVersion: args.accessVersion,
        serverName: args.serverName,
      }
    ),
  });
}
