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
 * uses for its sibling routes. Returns `null` only on the route's own
 * "User not found" 404 so the caller can translate to a 401; throws on
 * transport errors, unexpected statuses, and routing-level 404s (route not
 * deployed / wrong `CONVEX_HTTP_URL`).
 */

import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "./internal-backend.js";

const USERS_LOOKUP_PATH = "/internal/v1/users/lookup-by-external-id";

export interface ResolvedMcpjamUser {
  /** MCPJam user document id (Convex). */
  _id: string;
}

export async function resolveUserByExternalId(
  externalId: string
): Promise<ResolvedMcpjamUser | null> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const url = `${convexUrl}${USERS_LOOKUP_PATH}?externalId=${encodeURIComponent(
    externalId
  )}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-inspector-service-token": serviceToken },
  });
  if (response.status === 404) {
    if (await isEntityNotFound(response, "User not found")) {
      return null;
    }
    throw new Error(
      `User lookup route not found at ${convexUrl}${USERS_LOOKUP_PATH} — is the backend lookup route deployed?`
    );
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
