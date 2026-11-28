/**
 * A token bound to other origins than the one a connection sends to is never
 * sent: the server moved after the connection read its address.
 */
import { HOSTED_MODE } from "../config.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { credentialOrigin } from "./credential-header-binding.js";
import type { HostedOAuthRefreshOptions } from "./hosted-oauth-refresh.js";

/** What a refresh learned about its token; absent fields were not sent. */
export type DeliveredTokenFacts = {
  credentialId?: string;
  boundOrigins?: string[];
};

/** Whether a token bound to `bound` may not go to `targetOrigin`. */
export function boundElsewhere(
  bound: readonly string[] | undefined,
  targetOrigin: string | null | undefined,
): boolean {
  return (
    !!targetOrigin &&
    !!bound &&
    !bound.some((origin) => credentialOrigin(origin) === targetOrigin)
  );
}

/** The answer for a token held back because its server moved. */
export function serverMovedError(
  serverId: string,
  serverName: string,
): WebRouteError {
  return new WebRouteError(
    401,
    ErrorCode.UNAUTHORIZED,
    `"${serverName}" now points at another address, so its sign-in was not sent. Sign in again to connect.`,
    { oauthRequired: true, originRefused: true, serverId, serverName },
  );
}

/** The answer for a token the backend named no account or origins for. */
export function originUnconfirmedError(
  serverId: string,
  serverName: string,
): WebRouteError {
  return new WebRouteError(
    401,
    ErrorCode.UNAUTHORIZED,
    `MCPJam could not confirm which address "${serverName}"'s sign-in is for, so it was not sent. Sign in again to connect.`,
    { oauthRequired: true, originRefused: true, serverId, serverName },
  );
}

/**
 * Hands over a refreshed token only if it is tied to where the caller sends
 * it. Locally, a refresh that named no account must also say the origins.
 */
export function handOverRefreshedToken(
  accessToken: string,
  delivered: DeliveredTokenFacts,
  serverId: string,
  options: HostedOAuthRefreshOptions | undefined,
): string {
  const serverName = options?.serverName ?? serverId;
  if (boundElsewhere(delivered.boundOrigins, options?.targetOrigin)) {
    throw serverMovedError(serverId, serverName);
  }
  if (
    !HOSTED_MODE &&
    options?.targetOrigin &&
    !options.connectionId &&
    !delivered.boundOrigins
  ) {
    throw originUnconfirmedError(serverId, serverName);
  }
  options?.onDelivered?.(delivered);
  return accessToken;
}
