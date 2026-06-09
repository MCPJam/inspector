/**
 * Inspector-side client for the backend's service-token-gated
 * WorkOS-API-key → MCPJam-org binding endpoints
 * (`/internal/v1/workos-api-key-bindings`; see mcpjam-backend `convex/http.ts`).
 *
 * WorkOS has no native org binding for API keys, so the backend persists the
 * scope and Inspector reads it here to attach `x-mcpjam-acting-in-org` to
 * delegated `/api/v1/*` calls. Authenticated with `INSPECTOR_SERVICE_TOKEN`
 * via the `x-inspector-service-token` header — the dedicated header these
 * routes gate on (they do NOT accept `Authorization: Bearer`, unlike the
 * delegated-identity resolver).
 */

const BINDINGS_PATH = "/internal/v1/workos-api-key-bindings";

export interface WorkosKeyBinding {
  /** MCPJam organization id (Convex `Id<'organizations'>`). */
  mcpjamOrganizationId: string;
}

/**
 * Carries the backend HTTP status so the mint handler can map a
 * non-member (403) or malformed-id (400) rejection to the right client
 * status instead of flattening everything to a 502.
 */
export class WorkosKeyBindingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WorkosKeyBindingError";
    this.status = status;
  }
}

function getConfig(): { convexUrl: string; serviceToken: string } {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }
  return { convexUrl, serviceToken };
}

/**
 * Look up the org a WorkOS API key is bound to. Returns `null` when the
 * backend reports 404 (no binding) — the caller treats that as an orphaned
 * key (401). Throws on transport / unexpected status so the caller can 500.
 */
export async function lookupWorkosKeyBinding(
  workosApiKeyId: string,
): Promise<WorkosKeyBinding | null> {
  const { convexUrl, serviceToken } = getConfig();
  const url = `${convexUrl}${BINDINGS_PATH}?workosApiKeyId=${encodeURIComponent(
    workosApiKeyId,
  )}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-inspector-service-token": serviceToken },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Binding lookup failed (${response.status})`);
  }
  const body = (await response.json()) as { mcpjamOrganizationId?: unknown };
  if (typeof body?.mcpjamOrganizationId !== "string") {
    throw new Error("Binding lookup returned an invalid body");
  }
  return { mcpjamOrganizationId: body.mcpjamOrganizationId };
}

/**
 * Persist the org binding for a freshly minted WorkOS key. Throws on any
 * non-2xx — the mint handler revokes the WorkOS key when this fails so we
 * never leave an unscoped (orphaned) key alive.
 */
export async function createWorkosKeyBinding(args: {
  workosApiKeyId: string;
  mcpjamOrganizationId: string;
  mintedByUserId: string;
}): Promise<void> {
  const { convexUrl, serviceToken } = getConfig();
  const response = await fetch(`${convexUrl}${BINDINGS_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inspector-service-token": serviceToken,
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    let message = `Binding create failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // keep the status-only message
    }
    throw new WorkosKeyBindingError(response.status, message);
  }
}

/**
 * Remove the org binding for a revoked WorkOS key. The backend delete is
 * idempotent (200 whether or not a row existed); the caller treats a thrown
 * error as best-effort and does not fail the user-facing revoke.
 */
export async function removeWorkosKeyBinding(
  workosApiKeyId: string,
): Promise<void> {
  const { convexUrl, serviceToken } = getConfig();
  const url = `${convexUrl}${BINDINGS_PATH}?workosApiKeyId=${encodeURIComponent(
    workosApiKeyId,
  )}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "x-inspector-service-token": serviceToken },
  });
  if (!response.ok) {
    throw new Error(`Binding remove failed (${response.status})`);
  }
}
