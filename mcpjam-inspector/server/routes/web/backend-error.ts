/**
 * A failed answer from MCPJam's own backend, as a `WebRouteError`
 * (MJ-020, MJ-021).
 *
 * The status travels. So does the backend's `code`, when it is one a caller can
 * branch on; any other code is derived from the status instead of relayed as
 * an arbitrary string. The message follows `backendFailureText`: the route's
 * fixed copy in hosted mode, with the backend's text logged.
 */
import { backendFailureText } from "../../utils/backend-failure-text.js";
import { ErrorCode, WebRouteError } from "./errors.js";

/** Backend codes relayed as-is. */
const RELAYED_BACKEND_CODES: ReadonlySet<string> = new Set([
  ErrorCode.UNAUTHORIZED,
  ErrorCode.FORBIDDEN,
  ErrorCode.NOT_FOUND,
  ErrorCode.CONFLICT,
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.RATE_LIMITED,
  ErrorCode.BILLING_LIMIT_REACHED,
  ErrorCode.FEATURE_NOT_SUPPORTED,
]);

/** Status → code when the backend sent none of the above. */
const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

export interface BackendFailure {
  /** Log label for the call site. */
  source: string;
  /** The backend's HTTP status; anything outside 4xx/5xx answers 502. */
  status: number;
  /** The parsed response body, if there was one. */
  body: unknown;
  /** The route's own copy for this failure. */
  message: string;
  /** A code the route has always answered with, whatever the backend said. */
  code?: ErrorCode;
}

export function backendFailureRouteError(
  failure: BackendFailure,
): WebRouteError {
  const status =
    failure.status >= 400 && failure.status <= 599 ? failure.status : 502;
  const body =
    failure.body && typeof failure.body === "object"
      ? (failure.body as { code?: unknown; error?: unknown })
      : undefined;
  const relayed =
    typeof body?.code === "string" && RELAYED_BACKEND_CODES.has(body.code)
      ? (body.code as ErrorCode)
      : undefined;
  const code =
    failure.code ??
    relayed ??
    STATUS_TO_CODE[status] ??
    (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.VALIDATION_ERROR);
  return new WebRouteError(
    status,
    code,
    backendFailureText({
      source: failure.source,
      status,
      detail: body?.error,
      fallback: failure.message,
    }),
  );
}
