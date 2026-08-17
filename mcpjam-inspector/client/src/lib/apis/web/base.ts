import type { NormalizedError } from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
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

  constructor(
    status: number,
    code: string | null,
    message: string,
    normalized?: NormalizedError,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WebApiError";
    this.status = status;
    this.code = code;
    this.normalized = normalized;
    this.details = details;
  }
}

export async function webPost<TRequest, TResponse>(
  path: string,
  payload: TRequest,
  options?: { signal?: AbortSignal },
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
    throw new WebApiError(response.status, code, message, normalized, details);
  }

  return sanitizedPayload as TResponse;
}
