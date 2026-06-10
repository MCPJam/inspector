/**
 * Resolve an MCPJam user from a WorkOS user id (the user's `externalId`
 * in Convex).
 *
 * Used by the bearer middleware when an `sk_` WorkOS API key is presented,
 * and by the API-key mint route to record the minting user's Convex id on
 * the new `workosApiKeyBindings` row.
 *
 * Calls the backend's service-token-gated resolver
 * (`GET /internal/v1/users/lookup-by-external-id`; see mcpjam-backend
 * `convex/http.ts`). Authenticated with `INSPECTOR_SERVICE_TOKEN` via the
 * `x-inspector-service-token` header — the same channel `workos-key-bindings.ts`
 * uses for its sibling routes. Returns `null` on 404 (no matching user) so
 * the caller can translate to a 401; throws on transport / unexpected status.
 */

const USERS_LOOKUP_PATH = "/internal/v1/users/lookup-by-external-id";

export interface ResolvedMcpjamUser {
  /** MCPJam user document id (Convex). */
  _id: string;
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

export async function resolveUserByExternalId(
  externalId: string
): Promise<ResolvedMcpjamUser | null> {
  const { convexUrl, serviceToken } = getConfig();
  const url = `${convexUrl}${USERS_LOOKUP_PATH}?externalId=${encodeURIComponent(
    externalId
  )}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-inspector-service-token": serviceToken },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`User lookup failed (${response.status})`);
  }
  const body = (await response.json()) as { userId?: unknown };
  if (typeof body?.userId !== "string") {
    throw new Error("User lookup returned an invalid body");
  }
  return { _id: body.userId };
}
