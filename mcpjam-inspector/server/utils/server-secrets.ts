import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";

export interface ServerSecretsResult {
  env: Record<string, string> | null;
  headers: Record<string, string> | null;
}

function parseRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export async function fetchRuntimeServerSecrets(args: {
  bearerToken: string;
  projectId: string;
  serverId: string;
  accessScope?: "project_member" | "chat_v2";
  chatboxId?: string;
  accessVersion?: number;
}): Promise<ServerSecretsResult> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const RUNTIME_REVEAL_TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    RUNTIME_REVEAL_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/server/reveal-secrets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.bearerToken}`,
      },
      body: JSON.stringify({
        purpose: "runtime",
        projectId: args.projectId,
        serverId: args.serverId,
        ...(args.accessScope ? { accessScope: args.accessScope } : {}),
        ...(args.chatboxId ? { chatboxId: args.chatboxId } : {}),
        ...(typeof args.accessVersion === "number"
          ? { accessVersion: args.accessVersion }
          : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error as { code?: string }).code === "ABORT_ERR");
    throw new WebRouteError(
      isAbort ? 504 : 502,
      ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `Secret reveal service timed out after ${RUNTIME_REVEAL_TIMEOUT_MS}ms`
        : `Failed to reach secret reveal service: ${parseErrorMessage(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
        ? body.error
        : `Secret reveal failed (${response.status})`;
    throw new WebRouteError(response.status, ErrorCode.INTERNAL_ERROR, message);
  }

  if (!body?.success) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Secret reveal response was invalid"
    );
  }

  return {
    env: parseRecord(body.env),
    headers: parseRecord(body.headers),
  };
}
