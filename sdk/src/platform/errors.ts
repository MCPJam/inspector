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

/**
 * What a caller may safely say about a RATE_LIMITED refusal, read from the
 * error rather than its prose.
 *
 * Included operations (generation, insights) refuse on usage limits that
 * credits cannot lift, and the backend says so in the envelope it forwards as
 * `details`: its own refusal `code`, which bucket refused (`gatedBy`), whether
 * a top-up would help (`canTopUp`), and when to come back. Surfaces that show
 * an error to a person or a model (MCP, CLI, agents) read it here so they give
 * the same answer.
 *
 * Allowlisted on purpose: `details` is a server envelope, and only these
 * fields, shape-checked, are passed on.
 */
export interface PlatformRefusal {
  /** HTTP status of the refusal. */
  status: number;
  /** The stable v1 wire code, e.g. `RATE_LIMITED`. */
  code: string;
  /** The backend's own refusal code, e.g. `platform_capacity`. */
  reason?: string;
  /** Which limit refused, e.g. `burst`, `organization`. */
  gatedBy?: string;
  /** False when buying credits would not lift the refusal. */
  canTopUp?: boolean;
  /** Whether the same request can succeed later. */
  retryable?: boolean;
  /** Seconds until retrying can succeed, from `Retry-After` or the envelope. */
  retryAfterSeconds?: number;
}

const REFUSAL_REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

export function describePlatformRefusal(
  error: unknown
): PlatformRefusal | undefined {
  if (!isPlatformApiError(error)) return undefined;
  if (error.status !== 429 && error.code !== "RATE_LIMITED") return undefined;
  const details = error.details ?? {};
  const text = (key: string): string | undefined => {
    const value = details[key];
    return typeof value === "string" && REFUSAL_REASON_PATTERN.test(value)
      ? value
      : undefined;
  };
  const flag = (key: string): boolean | undefined =>
    typeof details[key] === "boolean" ? (details[key] as boolean) : undefined;
  const retryAfterMs = details.retryAfterMs;
  const retryAfterSeconds =
    error.retryAfter !== undefined
      ? error.retryAfter
      : typeof retryAfterMs === "number" &&
          Number.isFinite(retryAfterMs) &&
          retryAfterMs >= 0
        ? Math.ceil(retryAfterMs / 1000)
        : undefined;
  const refusal: PlatformRefusal = { status: error.status, code: error.code };
  const reason = text("code");
  if (reason) refusal.reason = reason;
  const gatedBy = text("gatedBy");
  if (gatedBy) refusal.gatedBy = gatedBy;
  const canTopUp = flag("canTopUp");
  if (canTopUp !== undefined) refusal.canTopUp = canTopUp;
  const retryable = flag("isRetryable");
  if (retryable !== undefined) refusal.retryable = retryable;
  if (retryAfterSeconds !== undefined)
    refusal.retryAfterSeconds = retryAfterSeconds;
  return refusal;
}

/**
 * One sentence telling a reader what to do about a refusal: when to come
 * back, and — when the server said so — that credits will not help. Never
 * suggests a top-up, another identity, or a retry loop.
 */
export function platformRefusalHint(refusal: PlatformRefusal): string {
  const when =
    refusal.retryAfterSeconds !== undefined
      ? `Retry after ${refusal.retryAfterSeconds}s, not sooner.`
      : "Wait before retrying; do not retry in a loop.";
  return refusal.canTopUp === false
    ? `${when} This is a usage limit: topping up credits does not lift it.`
    : when;
}
