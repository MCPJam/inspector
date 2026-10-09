/**
 * Shared SEP-2350 runtime scope step-up (`403 insufficient_scope`) challenge
 * plumbing for every client API surface — tools, resources, prompts.
 *
 * The server surfaces an upstream `InsufficientScopeError`'s `WWW-Authenticate`
 * challenge on the error body:
 *   - local routes: `mcpError.insufficientScope` (via the `jsonError` helper)
 *   - hosted routes: `details.insufficientScope` (via `mapRuntimeError` → 403)
 *
 * Both shapes flow through `parseInsufficientScopeChallenge`, which narrows the
 * untrusted resource-server payload. Consumers pass `requiredScope` into the
 * client step-up re-authorization (union of previously-granted + challenged
 * scopes, bounded per session). Treat every field as untrusted when rendering.
 */

import {
  parseAuthChallengeSignal,
  type AuthChallengeSignal,
} from "@mcpjam/sdk/browser";

export type { AuthChallengeSignal };

/** The `WWW-Authenticate` step-up challenge surfaced on a failed MCP request. */
export type InsufficientScopeChallenge = {
  requiredScope?: string;
  resourceMetadataUrl?: string;
  errorDescription?: string;
};

/**
 * Narrow an untrusted `insufficientScope` payload to the challenge shape.
 * Returns `undefined` unless at least one string field is present, so a
 * malformed or empty block never masquerades as an actionable step-up.
 */
export function parseInsufficientScopeChallenge(
  raw: unknown,
): InsufficientScopeChallenge | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const requiredScope =
    typeof r.requiredScope === "string" ? r.requiredScope : undefined;
  const resourceMetadataUrl =
    typeof r.resourceMetadataUrl === "string" ? r.resourceMetadataUrl : undefined;
  const errorDescription =
    typeof r.errorDescription === "string" ? r.errorDescription : undefined;
  // An empty object is a bare `insufficient_scope` (no scope, no pointer):
  // the server sends one only for a real step-up challenge.
  return { requiredScope, resourceMetadataUrl, errorDescription };
}

/**
 * Whether a parsed challenge can DRIVE a step-up re-authorization.
 *
 * Every `insufficient_scope` challenge is actionable. One naming a
 * `requiredScope` folds it into the re-auth union; one carrying a
 * `resourceMetadataUrl` lets discovery find the server's authoritative scopes;
 * one with neither (a bare `Bearer error="insufficient_scope"`, or only an
 * `error_description`) re-authorizes with the previously requested scopes
 * unioned with discovery's `scopes_supported`, which is the scope selection the
 * MCP authorization spec and Claude use. The bounded one-attempt budget still
 * applies, so a server that keeps refusing cannot loop the user.
 */
export function isActionableStepUpChallenge(
  challenge: InsufficientScopeChallenge | undefined,
): challenge is InsufficientScopeChallenge {
  return challenge !== undefined;
}

/**
 * Error thrown by the throw-based client APIs (resource read, prompt get) when
 * a request fails, carrying an optional SEP-2350 step-up challenge so the
 * `catch` site can drive the union-scope re-authorization without re-parsing
 * the transport-specific error body. `executeToolApi` uses a return-value
 * channel instead (its consumers read `response.insufficientScope`); this class
 * serves the surfaces whose consumers already `try/catch`.
 */
export class McpRequestError extends Error {
  insufficientScope?: InsufficientScopeChallenge;
  /** The typed sign-in challenge, stamped server-side with the auth method. */
  authChallenge?: AuthChallengeSignal;
  status?: number;

  constructor(
    message: string,
    opts?: {
      insufficientScope?: InsufficientScopeChallenge;
      authChallenge?: AuthChallengeSignal;
      status?: number;
    },
  ) {
    super(message);
    this.name = "McpRequestError";
    this.insufficientScope = opts?.insufficientScope;
    this.authChallenge = opts?.authChallenge;
    this.status = opts?.status;
  }
}

/**
 * Narrow an untrusted wire `authChallenge` to the typed signal. The server
 * puts it on `mcpError.authChallenge` (local), `details.authChallenge`
 * (hosted), or beside a completed result.
 */
export function parseAuthChallenge(
  raw: unknown,
): AuthChallengeSignal | undefined {
  return parseAuthChallengeSignal(raw);
}

/**
 * Pull a sign-in challenge off a caught error regardless of transport shape:
 * an `McpRequestError.authChallenge` (local throw path) or a hosted
 * `WebApiError`'s `details.authChallenge`.
 */
export function authChallengeFromError(
  error: unknown,
): AuthChallengeSignal | undefined {
  if (error instanceof McpRequestError && error.authChallenge) {
    return parseAuthChallenge(error.authChallenge);
  }
  const details = (error as { details?: { authChallenge?: unknown } })
    ?.details;
  return parseAuthChallenge(details?.authChallenge);
}

/**
 * Pull a step-up challenge off a caught error regardless of transport shape:
 * an `McpRequestError.insufficientScope` (local throw path) or a hosted
 * `WebApiError`'s `details.insufficientScope`. Returns `undefined` for anything
 * else, so an ordinary failure never triggers a spurious re-authorization.
 */
export function insufficientScopeFromError(
  error: unknown,
): InsufficientScopeChallenge | undefined {
  if (error instanceof McpRequestError && error.insufficientScope) {
    // Re-narrow through the parser so a malformed / empty `{}` challenge (truthy
    // but with no string fields) collapses to `undefined`, matching the hosted
    // `WebApiError.details` path below instead of leaking a non-actionable {}.
    return parseInsufficientScopeChallenge(error.insufficientScope);
  }
  const details = (error as { details?: { insufficientScope?: unknown } })
    ?.details;
  return parseInsufficientScopeChallenge(details?.insufficientScope);
}
