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
  "CONFLICT",
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
 *
 * `UNSUPPORTED` is also client-side (`status: 0`), and is a different claim
 * from the two above: the request SUCCEEDED, but its response showed the
 * backend does not implement a capability the caller asked for — an older
 * deployment that ignored a parameter it did not recognize. Reported as an
 * error rather than returned as data because the alternative is handing the
 * caller a well-formed answer to a question it did not ask.
 */
export type PlatformApiErrorCode =
  | PlatformV1ErrorCode
  | "NETWORK_ERROR"
  | "UNSUPPORTED";

export type PlatformApiErrorOptions = SdkErrorOptions & {
  /** HTTP status of the response; 0 for client-side (network/timeout) errors. */
  status: number;
  /** Optional unstructured details bag from the wire envelope. */
  details?: Record<string, unknown>;
  /** Seconds from a `Retry-After` header, when present (429 responses). */
  retryAfter?: number;
  /** Request path that failed, for diagnostics. */
  endpoint?: string;
  /** See `PlatformApiError.codeSource`. Omit when the code was not wire-derived. */
  codeSource?: "envelope" | "status";
};

export class PlatformApiError extends SdkError {
  public readonly status: number;
  public readonly details?: Record<string, unknown>;
  public readonly retryAfter?: number;
  public readonly endpoint?: string;
  /**
   * Did `code` come from the response's own `{ code }` envelope, or was it
   * ASSUMED from the HTTP status?
   *
   * The two are indistinguishable in `code` alone, and for 404 that ambiguity
   * has a caller-visible cost: an API answering `{ code: "NOT_FOUND" }` is
   * saying the resource does not exist, while a bare 404 with no envelope is
   * usually the route not being there at all — an older deployment, a function
   * not yet shipped. `STATUS_FALLBACK_CODES` maps both to `NOT_FOUND`, so a
   * caller wanting to fall back on an undeployed endpoint (rather than render
   * "no such thing") had nothing to branch on.
   *
   * `"status"` says the server offered no code of its own. It does NOT by
   * itself mean the route is missing — a proxy can strip a body from any
   * status — so treat it as one signal, alongside the status, not a verdict.
   *
   * Optional so an error constructed anywhere else keeps its current shape.
   */
  public readonly codeSource?: "envelope" | "status";

  constructor(message: string, code: string, options: PlatformApiErrorOptions) {
    super(message, code, options);
    this.name = "PlatformApiError";
    this.status = options.status;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.endpoint = options.endpoint;
    this.codeSource = options.codeSource;
  }
}

export function isPlatformApiError(error: unknown): error is PlatformApiError {
  return error instanceof PlatformApiError;
}
