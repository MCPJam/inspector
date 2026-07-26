import { z } from "zod";
import {
  describeError,
  isUnauthorized401,
  type NormalizedError,
} from "@mcpjam/sdk";
import { extractInsufficientScopeChallenge } from "../../utils/mcp-error-serialize.js";

export const ErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  // A write rejected because the resource isn't in a state that accepts it
  // (HTTP 409) — the request was well-formed, so VALIDATION_ERROR would
  // misreport it, and retrying it verbatim won't help. Project Environments
  // report stale `expectedRevision`, duplicate live names, and archive-state
  // rejections this way; the more specific ENVIRONMENT_REVISION_CONFLICT below
  // stays for the hosted UI, and collapses onto this code publicly.
  CONFLICT: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_SUPPORTED: "FEATURE_NOT_SUPPORTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // A billing/entitlement cap was hit (HTTP 402). The structured billing
  // payload (code "billing_limit_reached" / "billing_feature_not_included",
  // limit, allowedValue, plan, resetsAt, …) rides along in the WebRouteError
  // `details` so the client can rebuild a ConvexError and render the proper
  // upgrade message instead of a generic failure.
  BILLING_LIMIT_REACHED: "BILLING_LIMIT_REACHED",
  // A host with the enterprise-managed authorization POLICY connected an
  // `auto` server that has no stored XAA client registration. 409 (config
  // conflict), never a silent downgrade to the discover/OAuth ladder.
  // "Not configured", deliberately NOT "not enrolled": xaaConfigured proves
  // an IdP mode + client id registered at the resource authorization
  // server, not IdP enrollment — XAA_NOT_ENROLLED is reserved for the
  // future issuer-policy evaluator's denied verdicts. NOTE the local route
  // envelope (respondWithLocalRouteError) spreads `details` top-level and
  // drops `code`; clients branch on the top-level `reason:
  // "xaa_connection_not_configured"`, not this code.
  XAA_CONNECTION_NOT_CONFIGURED: "XAA_CONNECTION_NOT_CONFIGURED",
  // A project-environment eval launch resolved one environment revision but
  // the environment changed before `startTestSuiteRun` inserted the run
  // (`expectedEnvironmentRevision` mismatch, backend ENV_REVISION_CONFLICT).
  // 409; interactive callers surface "Environment changed — retry the run",
  // the scheduled worker retries through its trigger/idempotency path.
  ENVIRONMENT_REVISION_CONFLICT: "ENVIRONMENT_REVISION_CONFLICT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class WebRouteError extends Error {
  status: number;
  code: ErrorCode;
  details?: Record<string, unknown>;
  /**
   * Optional normalized describe-error block. When present, `webError`
   * forwards it onto the JSON response body so the client can render a
   * rich ErrorCard without re-classifying from the raw message.
   */
  normalized?: NormalizedError;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    normalized?: NormalizedError
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.normalized = normalized;
  }
}

export function webError(
  c: any,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  extras?: Record<string, unknown>
) {
  // `extras` is permissive (rpc-log collectors, etc.). If it carries a
  // `normalized` key, hoist it to the top-level response body — clients
  // pluck the rich block off the JSON envelope without re-classifying.
  const { normalized, ...restExtras } = (extras ?? {}) as Record<
    string,
    unknown
  > & { normalized?: NormalizedError };
  return c.json(
    {
      ...restExtras,
      code,
      message,
      ...(details ? { details } : {}),
      ...(normalized ? { normalized } : {}),
    },
    status
  );
}

export function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Explicit connection-error patterns. The previous implementation matched the
// bare substring `"connect"`, which also catches the word `"Reconnect"` —
// causing actionable upstream errors like "Reconnect the missing server(s)"
// to surface as 502 SERVER_UNREACHABLE instead of being passed through as
// 500/4xx. Match Node's ECONN* errno family, the standard "connection X"
// phrases, and a few well-known fetch/socket failures.
// Each pattern starts with `\b` so the "econn" and "connect" substrings
// inside the word `Reconnect` don't slip through — that exact bug is what
// caused upstream attachment errors to surface as 502 SERVER_UNREACHABLE.
// The errno branch requires the full `econn` prefix (Node's ECONN* family)
// rather than `econ` so server/tool names like "Economics" don't slip
// through and re-introduce the same class of false positive.
const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /\beconn[a-z]*/i,
  /\bconnection\s+(?:refused|reset|closed|timed?\s*out|aborted|error|failed)\b/i,
  /\b(?:failed|unable)\s+to\s+connect\b/i,
  /\bfetch\s+failed\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bgetaddrinfo\b/i,
];

export function mapRuntimeError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) {
    // Backfill normalized on existing WebRouteErrors so onError forwarding
    // always has a rich block, even when the throwing site predates the
    // describer wiring.
    if (!error.normalized) {
      error.normalized = describeError(error);
    }
    return error;
  }

  const message = parseErrorMessage(error);
  const lower = message.toLowerCase();
  const normalized = describeError(error);

  // SEP-2350 runtime scope step-up. A live MCP request against the hosted
  // proxy can surface a 403 `insufficient_scope` as an upstream
  // `InsufficientScopeError` (the SDK builds the transport
  // `onInsufficientScope: "throw"`). Recognize it BEFORE the generic 500 and
  // return 403 FORBIDDEN carrying the `WWW-Authenticate` challenge in
  // `details.insufficientScope`, so `webError` forwards it and the client can
  // drive the union-scope re-authorization. This single branch covers the
  // hosted tools / resources / prompts twins, which all rethrow into `onError`.
  const insufficientScope = extractInsufficientScopeChallenge(error);
  if (insufficientScope) {
    return new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      message,
      { insufficientScope },
      normalized
    );
  }

  // A raw 401 from the target MCP server is an authorization failure, not an
  // internal error — return the honest status. No `oauthRequired` here: this
  // mapper has no per-server auth context (multi-server managers), so the
  // escalation tag is applied only where the effective auth method is known
  // (the tokenless-discover onUnauthorized handler in createAuthorizedManager
  // and the local connect executor).
  if (isUnauthorized401(error)) {
    return new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      message,
      undefined,
      normalized
    );
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new WebRouteError(504, ErrorCode.TIMEOUT, message, undefined, normalized);
  }

  if (CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      message,
      undefined,
      normalized
    );
  }

  return new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    message,
    undefined,
    normalized
  );
}

export function assertBearerToken(c: any): string {
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Missing or invalid bearer token"
    );
  }
  return authHeader.slice("Bearer ".length);
}

export async function readJsonBody<T>(c: any): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body"
    );
  }
}

export function parseWithSchema<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      issue?.message ?? "Request validation failed"
    );
  }
  return parsed.data;
}
