import { normalizeInspectorFrontendUrl } from "./urls.js";

const HEALTH_FETCH_TIMEOUT_MS = 2_000;

interface InspectorHealthStatus {
  healthy: boolean;
  hasActiveClient: boolean;
  frontendUrl?: string;
}

export async function getInspectorHealth(
  baseUrl: string,
  timeoutMs = HEALTH_FETCH_TIMEOUT_MS,
): Promise<InspectorHealthStatus> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { healthy: false, hasActiveClient: false };
    }
    const body = (await response.json()) as {
      hasActiveClient?: boolean;
      frontend?: unknown;
    };
    const frontendUrl = normalizeInspectorFrontendUrl(body.frontend);
    return {
      healthy: true,
      hasActiveClient: body.hasActiveClient === true,
      ...(frontendUrl ? { frontendUrl } : {}),
    };
  } catch {
    return { healthy: false, hasActiveClient: false };
  }
}

export async function isInspectorHealthy(baseUrl: string): Promise<boolean> {
  const status = await getInspectorHealth(baseUrl);
  return status.healthy;
}
