import { authFetch } from "@/lib/session-token";
import { stripHostedRpcLogs } from "./rpc-logs";
import { ingestHostedRpcLogs } from "@/stores/traffic-log-store";

export class WebApiError extends Error {
  code: string | null;
  status: number;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "WebApiError";
    this.status = status;
    this.code = code;
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
    throw new WebApiError(response.status, code, message);
  }

  return sanitizedPayload as TResponse;
}
