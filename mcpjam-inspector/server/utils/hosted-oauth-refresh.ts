import type { UnauthorizedRefreshHandler } from "@mcpjam/sdk";
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";

export type HostedOAuthRefreshOptions = {
  accessScope?: "project_member" | "chat_v2";
  workspaceId?: string;
  shareToken?: string;
  chatboxToken?: string;
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
        ...(options?.workspaceId
          ? { workspaceId: options.workspaceId }
          : { projectId }),
        serverId,
        ...(options?.accessScope ? { accessScope: options.accessScope } : {}),
        ...(options?.shareToken ? { shareToken: options.shareToken } : {}),
        ...(options?.chatboxToken
          ? { chatboxToken: options.chatboxToken }
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
    const isReconnectRequired = code === "refresh_token_invalid";
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

export type HostedOAuthUnauthorizedHandlerArgs = {
  bearerToken: string;
  projectId: string;
  serverId: string;
  serverName: string;
  accessScope?: "project_member" | "chat_v2";
  workspaceId?: string;
  shareToken?: string;
  chatboxToken?: string;
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
  return async () => ({
    accessToken: await forceRefreshHostedOAuthAccessToken(
      args.bearerToken,
      args.projectId,
      args.serverId,
      {
        accessScope: args.accessScope,
        workspaceId: args.workspaceId,
        shareToken: args.shareToken,
        chatboxToken: args.chatboxToken,
        serverName: args.serverName,
      }
    ),
  });
}
