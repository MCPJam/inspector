import {
  PlatformApiClient,
  isPlatformApiError,
  type PlatformDeletionReceipt,
} from "@mcpjam/sdk/platform";
import { authFetch } from "@/lib/session-token";

const idempotencyStorageKey = (scope: {
  type: "organization" | "project";
  id: string;
}, actorId: string) => `mcpjam:deletion-request:${actorId}:${scope.type}:${scope.id}`;

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

type DeletionScope = { type: "organization" | "project"; id: string };
export class DeletionOutcomeUnknown extends Error {
  constructor(readonly scope: DeletionScope) {
    super("Checking deletion request");
  }
  get path(): string {
    return `/deletions/pending?type=${this.scope.type}&id=${encodeURIComponent(this.scope.id)}`;
  }
}

function uncertain(error: unknown): boolean {
  return isPlatformApiError(error) && (error.status === 0 || error.status >= 500);
}

async function submit(scope: DeletionScope, key: string, actorId: string, getToken?: GetDeletionToken, replayOnly = false) {
  try {
    const api = client(getToken);
    const receipt = await api[replayOnly ? "replayDeletion" : "requestDeletion"]({ scope }, { idempotencyKey: key });
    window.localStorage.removeItem(idempotencyStorageKey(scope, actorId));
    return receipt;
  } catch (error) {
    if (uncertain(error)) throw new DeletionOutcomeUnknown(scope);
    // A replay miss can precede the original acceptance; keep its key and
    // never turn that miss into a replacement deletion request.
    if (!replayOnly) window.localStorage.removeItem(idempotencyStorageKey(scope, actorId));
    throw error;
  }
}

export async function readDeletionAvailability(): Promise<boolean> {
  return (await client().getDeletionCapabilities()).available;
}

/** Negotiate before intake; a pending request can never use legacy deletion. */
export async function deleteScope(scope: DeletionScope, legacyDelete: () => Promise<unknown>, expectedAvailable?: boolean) {
  const api = client();
  const actor = await api.getMe();
  const existing = window.localStorage.getItem(idempotencyStorageKey(scope, actor.id));
  const capability = existing ? null : await api.getDeletionCapabilities();
  if (capability && expectedAvailable !== undefined && capability.available !== expectedAvailable) {
    throw new Error("Deletion availability changed. Close the dialog and try again.");
  }
  if (capability && !capability.available) {
    await legacyDelete();
    return true as const;
  }
  return startDeletion(scope);
}

/** Persist a key owned by the current actor before submitting any deletion. */
export async function startDeletion(scope: DeletionScope): Promise<PlatformDeletionReceipt> {
  const actor = await client().getMe();
  const storageKey = idempotencyStorageKey(scope, actor.id);
  const existing = window.localStorage.getItem(storageKey);
  const key = existing ?? globalThis.crypto.randomUUID();
  window.localStorage.setItem(storageKey, key);
  return submit(scope, key, actor.id, undefined, existing !== null);
}

/** Recovery only replays a saved request owned by the current signed-in actor. */
export async function recoverDeletion(search: string, getToken: GetDeletionToken): Promise<PlatformDeletionReceipt> {
  const params = new URLSearchParams(search);
  const type = params.get("type");
  const id = params.get("id");
  if ((type !== "project" && type !== "organization") || !id) throw new Error("Invalid deletion recovery link");
  const scope: DeletionScope = { type, id };
  const actor = await client(getToken).getMe();
  const key = window.localStorage.getItem(idempotencyStorageKey(scope, actor.id));
  if (!key) throw new Error("No pending request for this account");
  return submit(scope, key, actor.id, getToken, true);
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
