import { authFetch } from "@/lib/session-token";
import { ingestHostedRpcLogsFromPayload, stripHostedRpcLogs } from "./rpc-logs";

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
  requestBody: TRequest,
): Promise<TResponse> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  const { payload: sanitizedPayload } = stripHostedRpcLogs(body);
  ingestHostedRpcLogsFromPayload(body);

  if (!response.ok) {
    const code =
      typeof (sanitizedPayload as any)?.code === "string"
        ? (sanitizedPayload as any).code
        : typeof (sanitizedPayload as any)?.error === "string"
          ? (sanitizedPayload as any).error
          : null;
    const message =
      typeof (sanitizedPayload as any)?.message === "string"
        ? (sanitizedPayload as any).message
        : typeof (sanitizedPayload as any)?.error === "string"
          ? (sanitizedPayload as any).error
          : `Request failed (${response.status})`;
    throw new WebApiError(response.status, code, message);
  }

  return sanitizedPayload as TResponse;
}
