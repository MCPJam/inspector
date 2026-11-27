/**
 * The organizations `cloud login` and `cloud whoami` report, each with its
 * plan.
 *
 * The plan belongs to the organization. `GET /me` also returns a `plan`, but
 * that is a legacy per-user field: every account starts on "free" and nothing
 * changes it, so an Enterprise member was told they were on Free. Neither
 * command prints it.
 */
import type { PlatformApiClient } from "@mcpjam/sdk/platform";

export interface AccountOrganization {
  id: string;
  name: string;
  /** Billing plan slug (`free` / `team` / `enterprise`), null when unresolved. */
  plan: string | null;
}

/** The first page of the caller's organizations, which is all of them in practice. */
export async function listAccountOrganizations(
  client: Pick<PlatformApiClient, "listOrganizations">,
  signal?: AbortSignal
): Promise<AccountOrganization[]> {
  const page = await client.listOrganizations(signal ? { signal } : undefined);
  return page.items.map(({ id, name, plan }) => ({ id, name, plan }));
}
