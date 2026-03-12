export type HostedOAuthSurface = "sandbox" | "shared";

export type HostedOAuthStatus =
  | "needs_auth"
  | "launching"
  | "resuming"
  | "verifying"
  | "ready"
  | "error";

export interface HostedOAuthResumeMarker {
  surface: HostedOAuthSurface;
  serverName: string;
  serverUrl: string | null;
  completedAt: number;
  errorMessage?: string | null;
}

export interface HostedOAuthState {
  status: HostedOAuthStatus;
  errorMessage: string | null;
  serverUrl: string | null;
}

export const HOSTED_OAUTH_RESUME_STORAGE_KEY = "mcp-hosted-oauth-resume";

const HOSTED_OAUTH_RESUME_TTL_MS = 60_000;

export function writeHostedOAuthResumeMarker(
  marker: Omit<HostedOAuthResumeMarker, "completedAt">,
): void {
  try {
    localStorage.setItem(
      HOSTED_OAUTH_RESUME_STORAGE_KEY,
      JSON.stringify({
        ...marker,
        serverUrl: marker.serverUrl ?? null,
        errorMessage: marker.errorMessage ?? null,
        completedAt: Date.now(),
      }),
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readHostedOAuthResumeMarker(
  surface?: HostedOAuthSurface,
): HostedOAuthResumeMarker | null {
  try {
    const raw = localStorage.getItem(HOSTED_OAUTH_RESUME_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<HostedOAuthResumeMarker> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed.surface !== "sandbox" && parsed.surface !== "shared") ||
      typeof parsed.serverName !== "string" ||
      typeof parsed.completedAt !== "number"
    ) {
      clearHostedOAuthResumeMarker();
      return null;
    }

    if (Date.now() - parsed.completedAt > HOSTED_OAUTH_RESUME_TTL_MS) {
      clearHostedOAuthResumeMarker();
      return null;
    }

    if (surface && parsed.surface !== surface) {
      return null;
    }

    return {
      surface: parsed.surface,
      serverName: parsed.serverName,
      serverUrl:
        typeof parsed.serverUrl === "string" ? parsed.serverUrl : null,
      completedAt: parsed.completedAt,
      errorMessage:
        typeof parsed.errorMessage === "string" ? parsed.errorMessage : null,
    };
  } catch {
    clearHostedOAuthResumeMarker();
    return null;
  }
}

export function clearHostedOAuthResumeMarker(): void {
  localStorage.removeItem(HOSTED_OAUTH_RESUME_STORAGE_KEY);
}

export function isHostedOAuthBusy(status: HostedOAuthStatus): boolean {
  return (
    status === "launching" ||
    status === "resuming" ||
    status === "verifying"
  );
}

export function sanitizeHostedOAuthErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;

  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  return normalized
    .replace(/^Uncaught Error:\s*/i, "")
    .replace(/\s+at\s+(?:async\s+)?[A-Za-z0-9_$./<>-]+(?:\s+\(|$).*/s, "")
    .trim();
}
