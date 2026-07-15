/**
 * Relay tunnel grant plumbing against the Convex backend, shared by the
 * web tunnel routes (`routes/mcp/tunnels.ts`) and the public v1 surface
 * (`routes/v1/tunnels.ts`). Pure HTTP helpers — no tunnel-manager state.
 */
import { logger } from "../utils/logger";

// Grant minted by the Convex backend: a stable slug, the bearer URL with a
// fresh ?k= secret, and a connect token the relay edge verifies at the
// WebSocket handshake.
export interface RelayGrant {
  slug: string;
  url: string;
  secret?: string;
  secretHash?: string;
  secretVersion?: number;
  connectToken: string;
  connectTokenExpiresAt?: number;
  relayWsUrl: string;
}

function convexHeaders(authHeader?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }
  return headers;
}

// One shared deadline for every Convex round-trip in the tunnel lifecycle:
// a wedged backend must fail the route, not hang it.
const CONVEX_FETCH_TIMEOUT_MS = 15_000;

export async function convexFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  if (init.signal) {
    // The deadline owns the signal slot; a caller-provided one would be
    // silently clobbered below. Reject loudly until someone needs both
    // (then merge with AbortSignal.any).
    throw new Error(
      "convexFetch does not support caller-provided signals; the shared timeout owns cancellation"
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CONVEX_FETCH_TIMEOUT_MS
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Tunnel backend request timed out after ${CONVEX_FETCH_TIMEOUT_MS}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Error message from an upstream failure body; tolerates non-JSON bodies. */
async function upstreamErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  try {
    const error = (await response.json()) as { error?: string };
    if (error.error) return error.error;
  } catch {
    // Non-JSON error body (proxy HTML, empty 5xx); keep the fallback.
  }
  return `${fallback} (${response.status})`;
}

export function requireConvexHttpUrl(): string {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_HTTP_URL not configured");
  }
  return convexUrl;
}

export function validateGrant(
  data: Partial<RelayGrant> & { ok?: boolean }
): RelayGrant {
  if (!data.ok || !data.slug || !data.url) {
    throw new Error("Invalid response from tunnel service");
  }
  if (!data.connectToken || !data.relayWsUrl) {
    // Local-dev skew: a backend without the relay routes answered.
    throw new Error(
      "Tunnel backend does not support relay tunnels yet — deploy the relay-enabled backend (or set TUNNEL_RELAY_* env on it)"
    );
  }
  return data as RelayGrant;
}

// Fetch a relay tunnel grant from the Convex backend. `transport=relay`
// marks this caller as relay-capable; backends answer pre-relay
// inspectors (no marker) with an actionable 410. Every mint rotates the
// bearer secret AND disconnects/denies the previous grant at the edge.
export async function fetchRelayGrant(
  serverId: string,
  authHeader?: string,
  scope: "adapter-http" | "harness-web" = "adapter-http"
): Promise<RelayGrant> {
  const convexUrl = requireConvexHttpUrl();

  const scopeParam = scope === "harness-web" ? "&scope=harness-web" : "";
  const response = await convexFetch(
    `${convexUrl}/tunnels/token?serverId=${encodeURIComponent(
      serverId
    )}&transport=relay${scopeParam}`,
    {
      method: "GET",
      headers: convexHeaders(authHeader),
    }
  );

  if (!response.ok) {
    throw new Error(
      await upstreamErrorMessage(response, "Failed to fetch tunnel grant")
    );
  }

  return validateGrant(
    (await response.json()) as Partial<RelayGrant> & { ok?: boolean }
  );
}

// Rotate the bearer secret with the Convex backend. Single-phase: the
// backend patches the row AND revokes the old grant at the edge before
// responding, so the old URL is already dead; we just reconnect with the
// fresh grant.
export async function fetchRotationGrant(
  serverId: string,
  full: boolean,
  authHeader?: string
): Promise<RelayGrant> {
  const convexUrl = requireConvexHttpUrl();

  const response = await convexFetch(`${convexUrl}/tunnels/rotate`, {
    method: "POST",
    headers: convexHeaders(authHeader),
    body: JSON.stringify({ serverId, full, transport: "relay" }),
  });

  if (!response.ok) {
    throw new Error(
      await upstreamErrorMessage(response, "Failed to rotate tunnel")
    );
  }

  return validateGrant(
    (await response.json()) as Partial<RelayGrant> & { ok?: boolean }
  );
}

// Report tunnel closure to Convex backend (which also tells the relay edge
// to drop the socket and deny the now-superseded grant; the slug is kept so
// the URL stays stable on recreate). Best-effort: failures are logged.
export async function reportTunnelClosure(
  serverId: string,
  authHeader?: string
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return;
  }

  try {
    await convexFetch(`${convexUrl}/tunnels/close`, {
      method: "POST",
      headers: convexHeaders(authHeader),
      body: JSON.stringify({ serverId }),
    });
  } catch (error) {
    logger.error("Failed to report tunnel closure", error, { serverId });
  }
}

/**
 * Close a tunnel grant and surface failures (unlike `reportTunnelClosure`,
 * which is fire-and-forget for the web UI teardown path). The server record
 * is never touched — only the grant row is marked closed and the edge denies
 * the secret.
 */
export async function closeTunnelGrant(
  serverId: string,
  authHeader?: string
): Promise<void> {
  const convexUrl = requireConvexHttpUrl();

  const response = await convexFetch(`${convexUrl}/tunnels/close`, {
    method: "POST",
    headers: convexHeaders(authHeader),
    body: JSON.stringify({ serverId }),
  });

  if (!response.ok) {
    throw new Error(
      await upstreamErrorMessage(response, "Failed to close tunnel")
    );
  }
}
