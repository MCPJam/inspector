/**
 * The non-secret summary of a completed connect OAuth flow, sent with the
 * next connect request for that server so the server canvas can show how
 * authorization went (`OAuthFlowSummary` in `@mcpjam/sdk`).
 *
 * Built field by field from the finished flow state. It never carries an
 * access or refresh token, client secret, PKCE verifier, `state` or
 * authorization code: only whether a refresh token was issued, as a boolean.
 */
import type { OAuthFlowState, OAuthFlowSummary } from "@mcpjam/sdk/browser";

type RegistrationStrategy = NonNullable<OAuthFlowSummary["registrationStrategy"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeTokens(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}

function authorizationParam(url: string | undefined, name: string) {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    // A malformed authorization URL carries no parameters to report.
    return null;
  }
}

/**
 * The scopes the token response granted. RFC 6749 §5.1: a response without
 * `scope` granted what was requested.
 */
function grantedScopes(state: OAuthFlowState, requested: string[]): string[] {
  const body = state.lastResponse?.body;
  if (isRecord(body) && "access_token" in body && "scope" in body) {
    return scopeTokens(body.scope);
  }
  return requested;
}

export function buildOAuthFlowSummary(input: {
  state: OAuthFlowState;
  protocolVersion?: string;
  registrationStrategy?: RegistrationStrategy;
  /** The `iss` the authorization callback returned, if any. */
  callbackIss?: string | null;
  completedAt?: number;
}): OAuthFlowSummary {
  const { state } = input;
  const issuer =
    state.authorizationServerMetadata?.issuer ?? state.recordedIssuer;
  const scopesRequested = state.requestedScopes?.length
    ? [...new Set(state.requestedScopes)]
    : scopeTokens(authorizationParam(state.authorizationUrl, "scope"));
  const callbackIss = input.callbackIss?.trim() || undefined;
  const recordedIssuer = state.recordedIssuer ?? issuer;
  return {
    completedAt: input.completedAt ?? Date.now(),
    ...(issuer ? { issuer } : {}),
    ...(input.protocolVersion ? { protocolVersion: input.protocolVersion } : {}),
    ...(input.registrationStrategy
      ? { registrationStrategy: input.registrationStrategy }
      : {}),
    resourceIndicatorSent:
      authorizationParam(state.authorizationUrl, "resource") !== null,
    scopesRequested,
    scopesGranted: grantedScopes(state, scopesRequested),
    issReturned: callbackIss !== undefined,
    issValidated:
      callbackIss !== undefined && recordedIssuer === callbackIss,
    refreshTokenIssued: Boolean(state.refreshToken),
    ...(state.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: state.tokenEndpointAuthMethod }
      : {}),
  };
}

/** Summaries waiting for their server's next connect, by server name. */
const pending = new Map<string, OAuthFlowSummary>();

export function rememberOAuthFlowSummary(
  serverName: string,
  summary: OAuthFlowSummary,
): void {
  pending.set(serverName, summary);
}

/** The waiting summary for `serverName`, once: the next connect sends it. */
export function takeOAuthFlowSummary(
  serverName: string | undefined,
): OAuthFlowSummary | undefined {
  if (!serverName) return undefined;
  const summary = pending.get(serverName);
  pending.delete(serverName);
  return summary;
}
