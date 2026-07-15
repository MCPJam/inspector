import { SdkError, type SdkErrorOptions } from "../errors.js";

/**
 * Error codes emitted by the MCPJam Platform API (`/api/v1`) wire envelope
 * `{ code, message, details? }`. Mirrors the public contract in
 * `mcpjam-inspector/server/routes/v1/contract.ts`. New codes may be added
 * over time; treat unknown codes as non-retryable failures.
 */
export const PLATFORM_V1_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "FEATURE_NOT_SUPPORTED",
  "SERVER_UNREACHABLE",
  "TIMEOUT",
  "OAUTH_REQUIRED",
  "INTERNAL_ERROR",
] as const;

export type PlatformV1ErrorCode = (typeof PLATFORM_V1_ERROR_CODES)[number];

/**
 * Codes carried on `PlatformApiError.code`. Usually a wire code from the
 * envelope above; `NETWORK_ERROR` and `TIMEOUT` are also synthesized
 * client-side (with `status: 0`) when the request never produced a wire
 * envelope — fetch-level failures and client-side timeouts respectively.
 * Error responses with no envelope (empty bodies, proxy HTML) derive the
 * code from the HTTP status when unambiguous (401/403/404/429), else
 * `INTERNAL_ERROR`.
 */
export type PlatformApiErrorCode = PlatformV1ErrorCode | "NETWORK_ERROR";

export type PlatformApiErrorOptions = SdkErrorOptions & {
  /** HTTP status of the response; 0 for client-side (network/timeout) errors. */
  status: number;
  /** Optional unstructured details bag from the wire envelope. */
  details?: Record<string, unknown>;
  /** Seconds from a `Retry-After` header, when present (429 responses). */
  retryAfter?: number;
  /** Request path that failed, for diagnostics. */
  endpoint?: string;
};

export class PlatformApiError extends SdkError {
  public readonly status: number;
  public readonly details?: Record<string, unknown>;
  public readonly retryAfter?: number;
  public readonly endpoint?: string;

  constructor(
    message: string,
    code: string,
    options: PlatformApiErrorOptions
  ) {
    super(message, code, options);
    this.name = "PlatformApiError";
    this.status = options.status;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.endpoint = options.endpoint;
  }
}

export function isPlatformApiError(error: unknown): error is PlatformApiError {
  return error instanceof PlatformApiError;
}
