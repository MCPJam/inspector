/**
 * What a hosted MCP route's failed response may say (MJ-001).
 *
 * Every hosted route that connects to a caller's MCP server answers its
 * failures through here: the `/api/web/*` routes through
 * `withEphemeralConnection` and the direct-operation helper, the `/api/v1/*`
 * routes through `runV1ServerOp`. Those helpers apply it, not the routes, so a
 * route added on top of them is covered without asking.
 *
 * Two kinds of failure reach it:
 *
 * - A failure this server wrote (a `WebRouteError`) keeps its status, code and
 *   wording. The parts of it that carry what another server returned are
 *   reduced: an authorization server's recorded failure keeps its URL and
 *   status, a scope challenge its scopes and metadata URL, and a Cross-App
 *   Access token-exchange rejection is reported by its HTTP status.
 * - Any other failure is reported by `describeHostedConnectFailure`: the
 *   status line of the server's answer, a fixed sentence, or the egress
 *   guard's refusal, which is answered as a 400.
 *
 * Pure and mode-agnostic like its siblings. Callers decide when it applies.
 */

import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { XaaConnectFailureReason } from "../../shared/xaa-connect-failure.js";
import {
  describeHostedConnectFailure,
  projectHostedConnectFailureDetails,
  projectHostedConnectFailureLogs,
  redactNormalizedError,
} from "./hosted-connect-failure.js";
import {
  isPlainRecord,
  parseHttpStatus,
  parseHttpUrl,
  projectScopeChallenge,
} from "./hosted-upstream-projection.js";

/**
 * The wording of a failure this server wrote. A Cross-App Access rejection
 * names the server and the authorization server's HTTP status, and nothing
 * the authorization server said.
 */
export function projectHostedAuthoredFailureMessage(
  error: WebRouteError,
): string {
  const details = error.details;
  if (
    error.setupFailureSource === "xaa_mint" &&
    details?.reason === XaaConnectFailureReason.AUTHORIZATION_REJECTED
  ) {
    const serverName =
      typeof details.serverName === "string" && details.serverName.trim()
        ? `"${details.serverName}"`
        : "this server";
    const cause = error.cause;
    const status =
      cause instanceof WebRouteError
        ? parseHttpStatus(cause.details?.status)
        : undefined;
    return (
      `The authorization server for ${serverName} rejected MCPJam's access request` +
      `${status !== undefined ? ` (HTTP ${status})` : ""} — check the server's XAA client` +
      ` credentials and issuer in its auth settings.`
    );
  }
  return error.message;
}

/**
 * The details of a failure this server wrote. Everything is kept except the
 * two fields that carry another server's answer, which are reduced.
 */
export function projectHostedAuthoredFailureDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return details;
  const projected: Record<string, unknown> = { ...details };
  if ("failure" in projected) {
    projected.failure = projectAuthorizationServerFailure(projected.failure);
  }
  if ("insufficientScope" in projected) {
    const challenge = projectScopeChallenge(projected.insufficientScope);
    if (challenge) projected.insufficientScope = challenge;
    else delete projected.insufficientScope;
  }
  return projected;
}

/** An authorization server's recorded failure: its URL and HTTP status. */
function projectAuthorizationServerFailure(
  value: unknown,
): { url: string; status: number } | null {
  if (!isPlainRecord(value)) return null;
  const url = parseHttpUrl(value.url);
  const status = parseHttpStatus(value.status);
  return url !== undefined && status !== undefined ? { url, status } : null;
}

/**
 * A mapped hosted route failure and its log envelope, as the response may
 * report them. `routeError` is the mapping of `error`; it is updated in place,
 * so the capture decision and origin already made on it stand.
 */
export function projectHostedRouteFailure(
  routeError: WebRouteError,
  error: unknown,
  logs: Record<string, unknown> | undefined,
): { routeError: WebRouteError; logs: Record<string, unknown> | undefined } {
  if (error instanceof WebRouteError) {
    routeError.message = projectHostedAuthoredFailureMessage(error);
    routeError.details = projectHostedAuthoredFailureDetails(
      routeError.details,
    );
  } else {
    const failure = describeHostedConnectFailure(error, logs);
    if (failure.blockedTarget) {
      routeError.status = 400;
      routeError.code = ErrorCode.VALIDATION_ERROR;
    }
    routeError.message = failure.message;
    routeError.details = projectHostedConnectFailureDetails(routeError.details);
  }
  if (routeError.normalized) {
    routeError.normalized = redactNormalizedError(
      routeError.normalized,
      routeError.message,
    );
  }
  return { routeError, logs: projectHostedConnectFailureLogs(logs) };
}

/**
 * The same account for the `/api/v1/*` envelope, as the override `v1OnError`
 * takes: the wording, the code when the target was refused, and the details
 * rewrite.
 */
export function projectHostedV1Failure(
  error: unknown,
  logs: Record<string, unknown> | undefined,
): {
  message: string;
  code?: "VALIDATION_ERROR";
  details: (
    details: Record<string, unknown> | undefined,
  ) => Record<string, unknown> | undefined;
} {
  if (error instanceof WebRouteError) {
    return {
      message: projectHostedAuthoredFailureMessage(error),
      details: projectHostedAuthoredFailureDetails,
    };
  }
  const failure = describeHostedConnectFailure(error, logs);
  return {
    message: failure.message,
    ...(failure.blockedTarget ? { code: "VALIDATION_ERROR" as const } : {}),
    details: projectHostedConnectFailureDetails,
  };
}
