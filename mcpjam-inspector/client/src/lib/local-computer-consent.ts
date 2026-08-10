/**
 * Client side of the local-computer consent CAPABILITY.
 *
 * The server (`/api/mcp/computers/local-consent/*`, PR #3812) is the
 * authority: grant mints a token whose HASH it persists server-side; this
 * module stores the plaintext in `localStorage`, and it rides the
 * `X-MCPJam-Local-Consent` header on chat turns where the engine resolver
 * re-verifies it on every use. That server-side re-verification is the real
 * enforcement point — so the CLIENT treats a stored token as consent and does
 * NOT pre-verify. Pre-verifying (an async status racing grant/revoke and the
 * same-tab storage event) was a large, bug-prone race surface for zero real
 * safety: a stale/tampered token simply fails the next turn's server check.
 * localStorage is therefore the single source of truth here, read
 * synchronously.
 *
 * DEVICE-scoped (not per-project): the thing consented to is this machine
 * executing commands.
 *
 * Every server call goes through `authFetch`, which attaches BOTH the
 * inspector session header AND the verified WorkOS bearer (the consent path
 * is in `HOSTED_AUTH_PATH_PREFIXES`). We deliberately do NOT set the
 * `Authorization` header ourselves: doing so trips authFetch's
 * `callerProvidedAuthorization` guard and disables the on-401 session-token
 * refresh, which would leave grant/revoke stuck at 401 after a dev-server
 * restart. The routes mount `requireVerifiedAuth`, so a guest or unverified
 * bearer still can't mint.
 */
import { authFetch } from "@/lib/session-token";

const STORAGE_KEY = "mcp-local-computer-consent-v1";
const EVENT_NAME = "local-computer-consent-changed";

export interface StoredLocalComputerConsent {
  token: string;
  grantedAt: string;
}

export function loadStoredLocalComputerConsent(): StoredLocalComputerConsent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.token !== "string" || record.token.length < 16) {
      return null;
    }
    return {
      token: record.token,
      grantedAt:
        typeof record.grantedAt === "string" ? record.grantedAt : "unknown",
    };
  } catch {
    return null;
  }
}

/** Returns whether the write actually landed (storage can be disabled/full). */
function persist(consent: StoredLocalComputerConsent | null): boolean {
  try {
    if (consent) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredLocalComputerConsent(): void {
  persist(null);
}

export function subscribeLocalComputerConsent(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener("storage", onStorage);
  };
}

function consentRequest(
  path: "grant" | "verify" | "revoke",
  body?: unknown,
): Promise<Response> {
  return authFetch(`/api/mcp/computers/local-consent/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * Mint a fresh capability on the SERVER, without persisting it locally.
 *
 * Split from the persist step so a caller can keep the network wait
 * OUT of any "my own write" guard — an external revoke arriving mid-mint must
 * stay visible — and then persist (which dispatches the synchronous same-tab
 * event) in a tightly-scoped, guarded region. Returns null on any failure.
 */
export async function mintLocalComputerConsent(): Promise<StoredLocalComputerConsent | null> {
  try {
    const response = await consentRequest("grant");
    if (!response.ok) return null;
    const json = (await response.json()) as {
      token?: unknown;
      grantedAt?: unknown;
    };
    if (typeof json.token !== "string" || json.token.length < 16) return null;
    return {
      token: json.token,
      grantedAt:
        typeof json.grantedAt === "string" ? json.grantedAt : "unknown",
    };
  } catch {
    return null;
  }
}

/**
 * Persist a minted capability locally (storage + same-tab event). Returns
 * whether the write landed — a granted capability the UI can't read back
 * (storage disabled/full) would let the engine resolve local while no
 * `X-MCPJam-Local-Consent` header exists to send.
 */
export function persistLocalComputerConsent(
  consent: StoredLocalComputerConsent,
): boolean {
  return persist(consent);
}

/**
 * Convenience: mint + persist in one call. Returns whether consent ended up
 * stored — false on either a mint failure or a persist failure, so a caller
 * never treats a token it can't read back as granted.
 */
export async function grantLocalComputerConsent(): Promise<boolean> {
  const minted = await mintLocalComputerConsent();
  return minted ? persistLocalComputerConsent(minted) : false;
}

/**
 * SERVER-ONLY revoke: unlink the device's singleton capability. Deliberately
 * does NOT touch local storage — the caller clears storage synchronously up
 * front (the user's explicit forget) and this best-effort network call runs
 * after. Keeping it storage-free means a slow revoke can never, on resume,
 * delete a token a newer grant persisted while it was in flight.
 */
export async function revokeLocalComputerConsentOnServer(): Promise<void> {
  try {
    await consentRequest("revoke");
  } catch {
    // Local forget already happened; the server capability is best-effort.
  }
}
