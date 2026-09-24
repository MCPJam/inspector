import { authFetch } from "@/lib/session-token";
import { WebApiError } from "./base";

/**
 * Typed wrappers for the inspector's `/api/web/api-keys/*` management
 * surface. Mint / list / revoke only — validation and rate limiting
 * live server-side.
 *
 * `value` is only present on the create response; never persisted, never
 * shown a second time.
 */
export interface ApiKey {
  organizationId?: string | null;
  /**
   * Organization inventory only. `null` when the member who minted the key no
   * longer has an account — the key is still bound to the organization.
   */
  owner?: { id: string; name: string; email: string } | null;
  id: string;
  /**
   * `null` only in the organization inventory, for a key WorkOS could not be
   * asked about (its minter is gone). Such a key is shown by id.
   */
  name: string | null;
  obfuscated_value: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  /** When the key stops working; `null` for a key minted before expiry. */
  expires_at?: string | null;
}

export interface OrganizationApiKeyList {
  items: ApiKey[];
  /**
   * The organization has more keys than one listing returns, so `items` is
   * not the whole inventory. Shown as a warning rather than silently passing
   * for complete.
   */
  truncated: boolean;
}

export interface CreatedApiKey extends ApiKey {
  /**
   * Plaintext `sk_…` value. Returned ONCE from the create endpoint and
   * surfaced via the RevealOnceDialog. Discarded as soon as the dialog
   * closes — never written to localStorage / state stores.
   */
  value: string;
}

async function parseError(response: Response): Promise<never> {
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }
  const message =
    typeof body?.message === "string"
      ? body.message
      : `Request failed (${response.status})`;
  const code = typeof body?.code === "string" ? body.code : null;
  throw new WebApiError(response.status, code, message);
}

/** The signed-in user's own keys. */
export async function listApiKeys(): Promise<ApiKey[]> {
  const response = await authFetch("/api/web/api-keys", { method: "GET" });
  if (!response.ok) await parseError(response);
  const body = (await response.json()) as { items?: ApiKey[] };
  return Array.isArray(body.items) ? body.items : [];
}

/** Every key bound to one organization (owners and admins only). */
export async function listOrganizationApiKeys(
  organizationId: string,
): Promise<OrganizationApiKeyList> {
  const response = await authFetch(
    `/api/web/api-keys/organization/${encodeURIComponent(organizationId)}`,
    { method: "GET" },
  );
  if (!response.ok) await parseError(response);
  const body = (await response.json()) as {
    items?: ApiKey[];
    truncated?: boolean;
  };
  return {
    items: Array.isArray(body.items) ? body.items : [],
    truncated: body.truncated === true,
  };
}

export async function createApiKey(args: {
  name: string;
  /** MCPJam organization id (Convex) the key acts inside. Required. */
  organizationId: string;
  /** Days until the key stops working (1–365). Server default: 90. */
  expiresInDays?: number;
}): Promise<CreatedApiKey> {
  const response = await authFetch("/api/web/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: args.name,
      organizationId: args.organizationId,
      ...(args.expiresInDays !== undefined
        ? { expiresInDays: args.expiresInDays }
        : {}),
    }),
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as CreatedApiKey;
}

/** Revoke one of the signed-in user's OWN keys. */
export async function revokeApiKey(id: string): Promise<void> {
  const response = await authFetch(
    `/api/web/api-keys/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) await parseError(response);
}

/**
 * Revoke ANY key bound to an organization, as one of its owners or admins.
 * Succeeds (with `alreadyRevoked`) for a key that was already gone.
 */
export async function revokeOrganizationApiKey(
  organizationId: string,
  id: string,
): Promise<{ alreadyRevoked: boolean }> {
  const response = await authFetch(
    `/api/web/api-keys/organization/${encodeURIComponent(organizationId)}/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) await parseError(response);
  const body = (await response.json().catch(() => null)) as {
    alreadyRevoked?: unknown;
  } | null;
  return { alreadyRevoked: body?.alreadyRevoked === true };
}
