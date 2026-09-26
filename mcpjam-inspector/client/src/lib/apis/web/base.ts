import type { NormalizedError } from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { isServerRequestBudgetRefusal } from "@/shared/server-request-budget";
import { stripHostedRpcLogs } from "./rpc-logs";
import {
  ingestHostedHttpLogs,
  ingestHostedRpcLogs,
} from "@/stores/traffic-log-store";

export class WebApiError extends Error {
  code: string | null;
  status: number;
  /**
   * Server-attached describe-error block. Populated from the JSON error
   * body's `normalized` field when present. Always optional — older
   * servers / non-describer routes simply omit it and the ErrorCard
   * falls back to `describeError(this)` on its own.
   */
  normalized?: NormalizedError;
  /**
   * Server-attached structured details from the JSON error body (the
   * WebRouteError `details` webError forwards — e.g. `oauthRequired` on
   * tagged 401s). Optional; omitted when the route sends none.
   */
  details?: Record<string, unknown>;
  /**
   * The failing response's `x-request-id` — the join key to its Axiom row.
   *
   * Read from the response HEADER rather than the body: the server sets it on
   * every `/api/*` response in `requestLogContextMiddleware`, including the
   * 5xx it never got far enough to build a JSON envelope for. A body-only
   * field would be missing exactly when it is most needed.
   */
  requestId?: string;
  retryAfterMs?: number;

  constructor(
    status: number,
    code: string | null,
    message: string,
    normalized?: NormalizedError,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = "WebApiError";
    this.status = status;
    this.code = code;
    this.normalized = normalized;
    this.details = details;
    this.requestId = requestId;
  }
}

/**
 * The response's `x-request-id`, or nothing.
 *
 * Guarded because this runs on the ERROR path: a custom fetch wrapper or a test
 * double can hand back a response object without `headers`, and an unguarded
 * read there throws a TypeError that REPLACES the real failure. A missing
 * request id costs a diagnostic; a throw costs the error itself.
 */
export function requestIdOfResponse(response: {
  headers?: { get?: (name: string) => string | null };
}): string | undefined {
  try {
    return response.headers?.get?.("x-request-id") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A refusal from the per-server request budget on the hosted MCP operation
 * routes (MJ-012) is retried after the wait it names, a bounded number of
 * times. A paginated `tools/list` walk, or the `tools/execute` right after one,
 * can outrun that budget's burst, and its refill takes seconds.
 *
 * Retrying is safe on every route behind that budget, `tools/execute`
 * included: it is checked before the route handler runs, so a refused request
 * did nothing for a retry to repeat.
 *
 * Nothing else is retried. A 429 without the marker (the per-caller limits,
 * the guest and audio limits, the backend's own), or one that names a longer
 * wait than this allows, throws exactly as before.
 */
const SERVER_REQUEST_BUDGET_MAX_RETRIES = 3;
const SERVER_REQUEST_BUDGET_MAX_WAIT_SECONDS = 5;

/** How long to wait before retrying `response`, in ms, or `null` to throw. */
function serverRequestBudgetRetryMs(
  response: Response,
  details: Record<string, unknown> | undefined,
): number | null {
  if (response.status !== 429 || !isServerRequestBudgetRefusal(details)) {
    return null;
  }
  let retryAfter: string | null | undefined;
  try {
    retryAfter = response.headers?.get?.("retry-after");
  } catch {
    return null;
  }
  // Delta-seconds only: a missing or blank header, or an HTTP date, is not
  // retried.
  if (!retryAfter?.trim()) return null;
  const seconds = Number(retryAfter);
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > SERVER_REQUEST_BUDGET_MAX_WAIT_SECONDS
  ) {
    return null;
  }
  return seconds * 1000;
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
function waitBeforeRetry(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const abortReason = () =>
    signal?.reason ??
    new DOMException("The operation was aborted.", "AbortError");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function webPost<TRequest, TResponse>(
  path: string,
  payload: TRequest,
  options?: { signal?: AbortSignal },
): Promise<TResponse> {
  return webPostAttempt<TRequest, TResponse>(
    path,
    payload,
    options,
    SERVER_REQUEST_BUDGET_MAX_RETRIES,
  );
}

async function webPostAttempt<TRequest, TResponse>(
  path: string,
  payload: TRequest,
  options: { signal?: AbortSignal } | undefined,
  retriesLeft: number,
): Promise<TResponse> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  const {
    payload: sanitizedPayload,
    rpcLogs,
    httpLogs,
  } = stripHostedRpcLogs(body);
  ingestHostedRpcLogs(rpcLogs);
  ingestHostedHttpLogs(httpLogs);

  if (!response.ok) {
    const errBody = sanitizedPayload as Record<string, unknown> | null;
    const code =
      typeof errBody?.code === "string"
        ? errBody.code
        : typeof errBody?.error === "string"
          ? errBody.error
          : null;
    // Empty-string messages fall through to the next candidate — an error
    // with a blank message would otherwise surface as a blank toast.
    const message =
      (typeof errBody?.message === "string" && errBody.message.trim()) ||
      (typeof errBody?.error === "string" && errBody.error.trim()) ||
      `Request failed (${response.status})`;
    const normalized =
      errBody && typeof errBody.normalized === "object" && errBody.normalized
        ? (errBody.normalized as NormalizedError)
        : undefined;
    const details =
      errBody && typeof errBody.details === "object" && errBody.details
        ? (errBody.details as Record<string, unknown>)
        : undefined;
    const retryMs =
      retriesLeft > 0 ? serverRequestBudgetRetryMs(response, details) : null;
    if (retryMs !== null) {
      await waitBeforeRetry(retryMs, options?.signal);
      return webPostAttempt(path, payload, options, retriesLeft - 1);
    }
    const requestId = requestIdOfResponse(response);
    const error = new WebApiError(
      response.status,
      code,
      message,
      normalized,
      details,
      requestId,
    );
    const retryAfter = response.headers?.get?.("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      error.retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now());
    }
    throw error;
  }

  return sanitizedPayload as TResponse;
}
