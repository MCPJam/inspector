import { z } from "zod";

export const ErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_SUPPORTED: "FEATURE_NOT_SUPPORTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class WebRouteError extends Error {
  status: number;
  code: ErrorCode;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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
  return c.json(
    {
      ...(extras ?? {}),
      code,
      message,
      ...(details ? { details } : {}),
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
  if (error instanceof WebRouteError) return error;

  const message = parseErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new WebRouteError(504, ErrorCode.TIMEOUT, message);
  }

  if (CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, message);
  }

  return new WebRouteError(500, ErrorCode.INTERNAL_ERROR, message);
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
