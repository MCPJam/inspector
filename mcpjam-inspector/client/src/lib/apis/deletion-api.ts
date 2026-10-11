import {
  PlatformApiClient,
  isPlatformApiError,
  type PlatformDeletionReceipt,
} from "@mcpjam/sdk/platform";
import { authFetch } from "@/lib/session-token";

const idempotencyStorageKey = (scope: {
  type: "organization" | "project";
  id: string;
}) => `mcpjam:deletion-request:${scope.type}:${scope.id}`;

const deletionFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return authFetch(input as Parameters<typeof authFetch>[0], {
    ...init,
    headers,
  });
};

type GetDeletionToken = () => Promise<string | null | undefined>;

function client(getToken?: GetDeletionToken): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "/api/v1",
    getAuth: getToken ? async () => (await getToken()) ?? "" : () => "",
    fetch: getToken ? authFetch : deletionFetch,
  });
}

function stableKey(scope: {
  type: "organization" | "project";
  id: string;
}): string {
  const storageKey = idempotencyStorageKey(scope);
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = globalThis.crypto.randomUUID();
  window.localStorage.setItem(storageKey, created);
  return created;
}

/** Preserves the idempotency key after uncertain network outcomes. */
export async function startDeletion(scope: {
  type: "organization" | "project";
  id: string;
}): Promise<PlatformDeletionReceipt> {
  const key = stableKey(scope);
  const receipt = await client().requestDeletion(
    { scope },
    { idempotencyKey: key },
  );
  window.localStorage.removeItem(idempotencyStorageKey(scope));
  return receipt;
}

/** The independent status route is available when the normal app shell is not. */
export async function readDeletion(
  requestId: string,
  getToken?: GetDeletionToken,
): Promise<PlatformDeletionReceipt> {
  try {
    return await client(getToken).getDeletion({ requestId });
  } catch (error) {
    if (!isPlatformApiError(error) || error.status !== 404) throw error;
    // A current scope manager may grant themselves the narrow receipt access.
    // The backend performs a fresh role/IdP check and keeps unknown IDs opaque.
    await client(getToken).authorizeDeletion({ requestId });
    return await client(getToken).getDeletion({ requestId });
  }
}

export function cancelDeletion(
  requestId: string,
  getToken?: GetDeletionToken,
): Promise<PlatformDeletionReceipt> {
  return client(getToken).cancelDeletion({ requestId });
}
