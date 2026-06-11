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
  id: string;
  name: string;
  obfuscated_value: string;
  created_at?: string;
  last_used_at?: string | null;
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

export async function listApiKeys(): Promise<ApiKey[]> {
  const response = await authFetch("/api/web/api-keys", { method: "GET" });
  if (!response.ok) await parseError(response);
  const body = (await response.json()) as { items?: ApiKey[] };
  return Array.isArray(body.items) ? body.items : [];
}

export async function createApiKey(args: {
  name: string;
  /** MCPJam organization id (Convex) the key acts inside. Required. */
  organizationId: string;
}): Promise<CreatedApiKey> {
  const response = await authFetch("/api/web/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: args.name,
      organizationId: args.organizationId,
    }),
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as CreatedApiKey;
}

export async function revokeApiKey(id: string): Promise<void> {
  const response = await authFetch(
    `/api/web/api-keys/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) await parseError(response);
}
