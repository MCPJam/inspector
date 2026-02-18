import { authFetch } from "@/lib/session-token";

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

  if (!response.ok) {
    const code =
      typeof body?.code === "string"
        ? body.code
        : typeof body?.error === "string"
          ? body.error
          : null;
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : `Request failed (${response.status})`;
    throw new WebApiError(response.status, code, message);
  }

  return body as TResponse;
}
