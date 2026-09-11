/**
 * Client side of the local-browser consent CAPABILITY.
 *
 * The server (`/api/mcp/computers/local-browser/consent/*`) is the
 * authority: grant mints a token whose HASH it persists server-side; this
 * module stores the plaintext in `localStorage`, and it rides the
 * `X-MCPJam-Browser-Consent` header on chat turns where the engine resolver
 * re-verifies it on every use. That server-side re-verification is the real
 * enforcement point. Reading stored consent is synchronous and never verifies
 * on mount. Explicit shared-client setup verifies an existing token before
 * reusing it, so retrying setup does not rotate an active browser capability.
 *
 * DEVICE-scoped (not per-project): the thing consented to is this machine
 * controlling a browser and its signed-in websites.
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

const STORAGE_KEY = "mcp-local-browser-consent-v1";
const EVENT_NAME = "local-browser-consent-changed";
const SETUP_KEY = "mcp-local-browser-setup-pending-v1";

export function localBrowserSetupPending(): boolean {
  try {
    return localStorage.getItem(SETUP_KEY) === "true";
  } catch {
    return false;
  }
}

function setSetupPending(pending: boolean): void {
  if (pending) localStorage.setItem(SETUP_KEY, "true");
  else localStorage.removeItem(SETUP_KEY);
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

/**
 * Header that carries the consent capability on a local-engine chat turn. The
 * server reads it case-insensitively (`x-mcpjam-browser-consent`); this is the
 * canonical casing. Kept out of the request BODY so it can't enter persisted
 * transcripts.
 */
export const BROWSER_CONSENT_HEADER = "X-MCPJam-Browser-Consent";

export interface StoredLocalBrowserConsent {
  token: string;
  grantedAt: string;
}

export function loadStoredLocalBrowserConsent(): StoredLocalBrowserConsent | null {
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
function persist(consent: StoredLocalBrowserConsent | null): boolean {
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

export function clearStoredLocalBrowserConsent(): void {
  try {
    localStorage.removeItem(SETUP_KEY);
  } catch {
    /* Storage may be blocked. */
  }
  // Subscribers must see the complete cleared state in one notification.
  persist(null);
}

export function subscribeLocalBrowserConsent(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === STORAGE_KEY ||
      event.key === SETUP_KEY ||
      event.key === null
    )
      callback();
  };
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener("storage", onStorage);
  };
}

class BrowserPermissionUnavailableError extends Error {}

async function consentRequest(
  path: "grant" | "verify" | "revoke",
  body?: unknown,
): Promise<Response> {
  const response = await authFetch(
    `/api/mcp/computers/local-browser/consent/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok) {
    const failure = await response
      .clone()
      .json()
      .catch(() => null);
    if (failure?.code === "browser_runtime_unavailable") {
      throw new BrowserPermissionUnavailableError(
        "Local Browser isn't enabled for this user or server.",
      );
    }
  }
  return response;
}

/**
 * Mint a fresh capability on the SERVER, without persisting it locally.
 *
 * Split from the persist step so a caller can keep the network wait
 * OUT of any "my own write" guard — an external revoke arriving mid-mint must
 * stay visible — and then persist (which dispatches the synchronous same-tab
 * event) in a tightly-scoped, guarded region. Rollout denials carry a readable
 * error to the permission prompt; other failures return null.
 */
export async function mintLocalBrowserConsent(): Promise<StoredLocalBrowserConsent | null> {
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
  } catch (error) {
    if (error instanceof BrowserPermissionUnavailableError) throw error;
    return null;
  }
}

/**
 * Persist a minted capability locally (storage + same-tab event). Returns
 * whether the write landed — a granted capability the UI can't read back
 * (storage disabled/full) would let the engine resolve local while no
 * `X-MCPJam-Browser-Consent` header exists to send.
 */
export function persistLocalBrowserConsent(
  consent: StoredLocalBrowserConsent,
): boolean {
  return persist(consent);
}

/**
 * Convenience: mint + persist in one call. Returns whether consent ended up
 * stored — false on either a mint failure or a persist failure, so a caller
 * never treats a token it can't read back as granted. A persist failure
 * releases the just-minted (now unpresentable) server capability,
 * best-effort and token-scoped.
 */
export async function grantLocalBrowserConsent(): Promise<boolean> {
  const minted = await mintLocalBrowserConsent();
  if (!minted) return false;
  const stored = persistLocalBrowserConsent(minted);
  if (!stored) void revokeLocalBrowserConsentOnServer(minted.token);
  return stored;
}

let setupInFlight: Promise<boolean> | null = null;

/** Only an explicit Allow calls this; retries reuse the saved capability. */
export function enableLocalBrowserForAllClients(): Promise<boolean> {
  if (setupInFlight) return setupInFlight;
  setupInFlight = (async () => {
    try {
      setSetupPending(true);
    } catch {
      return false;
    }
    let stored = loadStoredLocalBrowserConsent();
    if (stored) {
      const verified = await consentRequest("verify", { token: stored.token });
      if (!verified.ok)
        throw new Error("Couldn't verify Browser permission. Retry setup.");
      const result = (await verified.json()) as { valid?: boolean };
      if (!result.valid) stored = null;
    }
    if (!stored) {
      if (!(await grantLocalBrowserConsent())) return false;
      stored = loadStoredLocalBrowserConsent();
    }
    if (!stored) return false;
    const token = stored.token;
    const response = await authFetch(
      "/api/mcp/computers/local-browser/enable-clients",
      {
        method: "POST",
        headers: { [BROWSER_CONSENT_HEADER]: token },
      },
    );
    if (!response.ok) {
      throw new Error(
        "Browser permission was saved, but clients could not be enabled. Retry setup.",
      );
    }
    // A revoke or grant in another tab wins over this delayed completion.
    if (loadStoredLocalBrowserConsent()?.token !== token) return false;
    setSetupPending(false);
    return true;
  })().finally(() => {
    setupInFlight = null;
  });
  return setupInFlight;
}

/**
 * SERVER-ONLY revoke: unlink the device's capability. Deliberately does NOT
 * touch local storage — the caller clears storage synchronously up front (the
 * user's explicit forget) and this best-effort network call runs after.
 * Keeping it storage-free means a slow revoke can never, on resume, delete a
 * token a newer grant persisted while it was in flight — and passing the
 * token being revoked makes the SERVER side equally race-safe: the server
 * unlinks only if that token still matches, so a delayed revoke can't sever
 * a capability a newer grant rotated in while this request was in flight.
 * With no token (nothing was stored locally) the server unlinks
 * unconditionally — the user's intent is to sever this device.
 */
export async function revokeLocalBrowserConsentOnServer(
  token: string | null = null,
): Promise<void> {
  try {
    await consentRequest("revoke", token != null ? { token } : undefined);
  } catch {
    // Local forget already happened; the server capability is best-effort.
  }
}
