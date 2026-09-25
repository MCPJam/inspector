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

import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "./internal-backend.js";

const BINDINGS_PATH = "/internal/v1/workos-api-key-bindings";

export interface WorkosKeyBinding {
  /** MCPJam organization id (Convex `Id<'organizations'>`). */
  mcpjamOrganizationId: string;
  /**
   * When the key stops working (epoch ms). Null (or absent) for a key minted
   * before expiry existed — those do not expire — and from a backend that
   * predates the field.
   */
  expiresAt?: number | null;
}

/**
 * Carries the backend HTTP status so the mint handler can map a
 * non-member (403) or malformed-id (400) rejection to the right client
 * status instead of flattening everything to a 502.
 */
export class WorkosKeyBindingError extends Error {
  readonly status: number;
  /**
   * The backend's reason code, when it sent one — e.g. `ADMINS_ONLY` on a
   * mint refused because the organization lets only its owners and admins
   * create keys (MJ-010).
   */
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "WorkosKeyBindingError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Look up the org a WorkOS API key is bound to. Returns `null` only on the
 * route's own "Binding not found" 404 — the caller treats that as an
 * orphaned key (401). Throws on transport / unexpected status, and on a
 * routing-level 404 (route not deployed / wrong `CONVEX_HTTP_URL`), so the
 * caller can 500 instead of mis-reporting a config error as an orphaned key.
 */
const BINDING_LOOKUP_TIMEOUT_MS = 5_000;

export async function lookupWorkosKeyBinding(
  workosApiKeyId: string,
): Promise<WorkosKeyBinding | null> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const url = `${convexUrl}${BINDINGS_PATH}?workosApiKeyId=${encodeURIComponent(
    workosApiKeyId,
  )}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-inspector-service-token": serviceToken },
    // Bounded concurrency caps how many lookups run, not how long one may
    // hang; a stalled internal response must not pin the caller's request.
    signal: AbortSignal.timeout(BINDING_LOOKUP_TIMEOUT_MS),
  });
  if (response.status === 404) {
    if (await isEntityNotFound(response, "Binding not found")) {
      return null;
    }
    throw new Error(
      `Binding lookup route not found at ${convexUrl}${BINDINGS_PATH} — is the backend bindings route deployed?`,
    );
  }
  if (!response.ok) {
    throw new Error(`Binding lookup failed (${response.status})`);
  }
  const body = (await response.json()) as {
    mcpjamOrganizationId?: unknown;
    expiresAt?: unknown;
  };
  if (typeof body?.mcpjamOrganizationId !== "string") {
    throw new Error("Binding lookup returned an invalid body");
  }
  return {
    mcpjamOrganizationId: body.mcpjamOrganizationId,
    expiresAt:
      typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
        ? body.expiresAt
        : null,
  };
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
  /** Epoch ms. The same instant the WorkOS key was minted to expire at. */
  expiresAt?: number;
}): Promise<void> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
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
    let code: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: unknown;
        code?: unknown;
      };
      if (typeof body?.error === "string") message = body.error;
      if (typeof body?.code === "string") code = body.code;
    } catch {
      // keep the status-only message
    }
    throw new WorkosKeyBindingError(response.status, message, code);
  }
}

/**
 * Remove the org binding for a revoked WorkOS key. The backend delete is
 * idempotent (200 whether or not a row existed); the caller treats a thrown
 * error as best-effort and does not fail the user-facing revoke.
 *
 * `actorUserId` names who is revoking, and is an MCPJam `Id<'users'>` — NOT
 * the WorkOS `sub`. The backend rejects the wrong one with a 400 rather than
 * recording a meaningless actor, so resolve the user first
 * (`resolveUserByExternalId`) and omit the argument if that lookup comes back
 * empty. Omitting it is a supported state, not a failure: the backend then
 * records the revocation as unattributed instead of inventing an actor.
 */
export async function removeWorkosKeyBinding(
  workosApiKeyId: string,
  actorUserId?: string,
): Promise<void> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const params = new URLSearchParams({ workosApiKeyId });
  if (actorUserId) params.set("actorUserId", actorUserId);
  const url = `${convexUrl}${BINDINGS_PATH}?${params.toString()}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "x-inspector-service-token": serviceToken },
  });
  if (!response.ok) {
    // Carry the status: a 403 here means the backend refused the revoke
    // because the actor did not mint the key, which is a different event from
    // an unreachable backend and the caller logs it as one.
    throw new WorkosKeyBindingError(
      response.status,
      `Binding remove failed (${response.status})`,
    );
  }
}

const ORGANIZATION_API_KEYS_PATH = "/internal/v1/organization-api-keys";
const ORGANIZATION_KEY_TIMEOUT_MS = 5_000;

export interface OrganizationKeyArgs {
  /** MCPJam organization id (Convex `Id<'organizations'>`). */
  organizationId: string;
  /** MCPJam `Id<'users'>` of the admin acting, NOT the WorkOS `sub`. */
  actorUserId: string;
  workosApiKeyId: string;
}

function organizationKeyQuery(args: OrganizationKeyArgs): string {
  return new URLSearchParams({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    workosApiKeyId: args.workosApiKeyId,
  }).toString();
}

/**
 * Ask the backend whether `actorUserId` may revoke `workosApiKeyId` as an
 * owner or admin of `organizationId`. Call it BEFORE deleting the key at
 * WorkOS: that delete cannot be undone, so the decision has to come first.
 *
 * Throws `WorkosKeyBindingError` with the backend's status on a decision the
 * caller should relay (403 not an admin, 404 no such key in this org, 400
 * malformed ids). Throws a plain `Error` when there is no decision at all —
 * transport failure, timeout, or a backend that predates the route — and the
 * caller must then refuse rather than revoke.
 */
export async function authorizeOrganizationKeyRevoke(
  args: OrganizationKeyArgs,
): Promise<void> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const response = await fetch(
    `${convexUrl}${ORGANIZATION_API_KEYS_PATH}/revoke-authorization?${organizationKeyQuery(args)}`,
    {
      method: "GET",
      headers: { "x-inspector-service-token": serviceToken },
      signal: AbortSignal.timeout(ORGANIZATION_KEY_TIMEOUT_MS),
    },
  );
  if (response.ok) return;
  if (response.status === 404) {
    if (await isEntityNotFound(response, "API key not found")) {
      throw new WorkosKeyBindingError(404, "API key not found");
    }
    throw new Error(
      "Organization key revoke-authorization route not found — is the backend deployed?",
    );
  }
  if (response.status === 403 || response.status === 400) {
    throw new WorkosKeyBindingError(
      response.status,
      `Revoke authorization refused (${response.status})`,
    );
  }
  throw new Error(`Revoke authorization failed (${response.status})`);
}

/**
 * Drop the binding of a key an org admin has just revoked at WorkOS. The
 * backend re-checks admin rank, writes the audit row naming both the admin
 * and the minter, and is idempotent (200 whether or not a row existed).
 * Throws on any non-2xx; the caller treats that as best-effort cleanup, since
 * the WorkOS key is already gone.
 */
export async function removeOrganizationKeyBinding(
  args: OrganizationKeyArgs,
): Promise<void> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const response = await fetch(
    `${convexUrl}${ORGANIZATION_API_KEYS_PATH}?${organizationKeyQuery(args)}`,
    {
      method: "DELETE",
      headers: { "x-inspector-service-token": serviceToken },
      signal: AbortSignal.timeout(ORGANIZATION_KEY_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new WorkosKeyBindingError(
      response.status,
      `Organization binding remove failed (${response.status})`,
    );
  }
}
