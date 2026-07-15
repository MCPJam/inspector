import type { NormalizedError } from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { stripHostedRpcLogs } from "./rpc-logs";
import { ingestHostedRpcLogs } from "@/stores/traffic-log-store";

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
): Promise<TResponse> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  const { payload: sanitizedPayload, rpcLogs } = stripHostedRpcLogs(body);
  ingestHostedRpcLogs(rpcLogs);

  if (!response.ok) {
    const errBody = sanitizedPayload as Record<string, unknown> | null;
    const code =
      typeof errBody?.code === "string"
        ? errBody.code
        : typeof errBody?.error === "string"
          ? errBody.error
          : null;
    const message =
      typeof errBody?.message === "string"
        ? errBody.message
        : typeof errBody?.error === "string"
          ? errBody.error
          : `Request failed (${response.status})`;
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
