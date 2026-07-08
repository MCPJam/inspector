/**
 * Inspector-side client for the backend's service-token-gated API-key
 * readiness check (`/internal/v1/organizations/api-key-readiness`; see
 * mcpjam-backend `convex/http.ts` + `convex/organizationsWorkos.ts`).
 *
 * WorkOS API keys require the calling user to have an active WorkOS
 * organization membership. MCPJam orgs/members are synced to matching WorkOS
 * Organizations/Memberships in the background (org-sync and membership-sync
 * complete on independent timelines and can each fail/retry), so before
 * minting a key we ask the backend "is *this* org, for *this* caller, ready
 * right now" rather than assuming readiness from the session.
 *
 * Authenticated with `INSPECTOR_SERVICE_TOKEN` via the
 * `x-inspector-service-token` header — the same channel `workos-key-bindings.ts`
 * / `identity.ts` use for their sibling routes.
 */

import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "./internal-backend.js";

const READINESS_PATH = "/internal/v1/organizations/api-key-readiness";

export type ApiKeyReadinessReason =
  | "org_pending"
  | "org_failed"
  | "membership_pending"
  | "membership_failed";

export interface ApiKeyReadiness {
  ready: boolean;
  workosOrganizationId: string | null;
  reason?: ApiKeyReadinessReason;
}

const API_KEY_READINESS_REASONS = new Set<ApiKeyReadinessReason>([
  "org_pending",
  "org_failed",
  "membership_pending",
  "membership_failed",
]);

/**
 * Carries the backend HTTP status so the mint handler can map a
 * not-a-member (403), org-not-found (404), or malformed-id (400) rejection
 * to the right client status instead of flattening everything to a 502.
 */
export class ApiKeyReadinessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiKeyReadinessError";
    this.status = status;
  }
}

// The readiness check runs on the user's synchronous key-mint request path —
// a hung backend must not hang that request indefinitely.
const READINESS_TIMEOUT_MS = 5_000;

/**
 * Ask the backend whether `mcpjamUserId` can mint a WorkOS-backed API key
 * scoped to `mcpjamOrganizationId` right now. Throws `ApiKeyReadinessError`
 * with the backend's status (403 not-a-member, 404 org-not-found, 400
 * malformed ids) so the route can translate it; throws a plain `Error` on
 * transport failures, a timeout, or an undeployed route.
 */
export async function resolveApiKeyReadiness(
  mcpjamOrganizationId: string,
  mcpjamUserId: string,
): Promise<ApiKeyReadiness> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const url = `${convexUrl}${READINESS_PATH}?organizationId=${encodeURIComponent(
    mcpjamOrganizationId,
  )}&userId=${encodeURIComponent(mcpjamUserId)}`;

  // The timeout must stay armed through body consumption, not just until
  // `fetch()` resolves — `fetch()` only settles once headers arrive, so a
  // backend that sends headers and then stalls the body would otherwise
  // hang `response.json()` / `isEntityNotFound`'s own `.json()` call
  // indefinitely despite the "timeout" existing in name only.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-inspector-service-token": serviceToken },
      signal: controller.signal,
    });

    if (response.status === 404) {
      if (await isEntityNotFound(response, "Organization not found")) {
        throw new ApiKeyReadinessError(404, "Organization not found");
      }
      throw new Error(
        `Readiness route not found at ${convexUrl}${READINESS_PATH} — is it deployed?`,
      );
    }
    if (response.status === 403) {
      throw new ApiKeyReadinessError(403, "Not a member of this organization");
    }
    if (response.status === 400) {
      throw new ApiKeyReadinessError(400, "Invalid organization or user id");
    }
    if (!response.ok) {
      throw new Error(`API key readiness check failed (${response.status})`);
    }

    const body = (await response.json()) as {
      ready?: unknown;
      workosOrganizationId?: unknown;
      reason?: unknown;
    };
    if (typeof body?.ready !== "boolean") {
      throw new Error("API key readiness check returned an invalid body");
    }
    return {
      ready: body.ready,
      workosOrganizationId:
        typeof body.workosOrganizationId === "string"
          ? body.workosOrganizationId
          : null,
      reason: API_KEY_READINESS_REASONS.has(body.reason as ApiKeyReadinessReason)
        ? (body.reason as ApiKeyReadinessReason)
        : undefined,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("API key readiness check timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
