/**
 * Client side of the local-computer consent CAPABILITY.
 *
 * The server (`/api/mcp/computers/local-consent/*`, PR #3812) is the
 * authority: grant mints a token whose hash it persists; this module stores
 * the plaintext in `localStorage` and the UI treats consent as granted ONLY
 * after a server `verify` succeeds — a localStorage value alone proves
 * nothing (any script can write one; only the server knows the hash).
 *
 * DEVICE-scoped (not per-project): the thing consented to is this machine
 * executing commands. The stored token is what later rides the
 * `X-MCPJam-Local-Consent` header on chat turns.
 *
 * Every server call goes through `authFetch` (inspector session header) with
 * an explicit WorkOS bearer — the routes mount `requireVerifiedAuth`, so a
 * guest or an unverified bearer can never mint or verify.
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
  accessToken: string,
  body?: unknown,
): Promise<Response> {
  return authFetch(`/api/mcp/computers/local-consent/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Mint + store a fresh capability. Returns whether the grant succeeded. */
export async function grantLocalComputerConsent(
  accessToken: string,
): Promise<boolean> {
  try {
    const response = await consentRequest("grant", accessToken);
    if (!response.ok) return false;
    const json = (await response.json()) as {
      token?: unknown;
      grantedAt?: unknown;
    };
    if (typeof json.token !== "string" || json.token.length < 16) return false;
    // Persistence is the whole point — a granted capability the UI can't read
    // back (storage disabled/full) would let the engine resolve local while
    // no `X-MCPJam-Local-Consent` header exists to send. Report the failure.
    return persist({
      token: json.token,
      grantedAt:
        typeof json.grantedAt === "string" ? json.grantedAt : "unknown",
    });
  } catch {
    return false;
  }
}

/**
 * Verify the stored capability against the server. A definitive "no" (the
 * server answered `valid:false` — revoked elsewhere, or rotated by another
 * browser profile) CLEARS the stale token so the UI re-prompts; a network
 * failure returns false WITHOUT clearing (the capability may still be good).
 */
export async function verifyStoredLocalComputerConsent(
  accessToken: string,
): Promise<boolean> {
  const stored = loadStoredLocalComputerConsent();
  if (!stored) return false;
  try {
    const response = await consentRequest("verify", accessToken, {
      token: stored.token,
    });
    if (!response.ok) return false;
    const json = (await response.json()) as { valid?: unknown };
    if (json.valid === true) return true;
    // Clear ONLY if the stored token is still the one we verified. Granting
    // rotates the server capability and storage events trigger concurrent
    // refreshes, so an in-flight verify of token A can land after a new tab
    // (or a fresh grant) stored token B — clearing then would delete a
    // perfectly good B on A's stale "no".
    const current = loadStoredLocalComputerConsent();
    if (current?.token === stored.token) {
      clearStoredLocalComputerConsent();
    }
    return false;
  } catch {
    return false;
  }
}

/** Revoke on the server AND forget locally (best-effort on the server side). */
export async function revokeLocalComputerConsent(
  accessToken: string,
): Promise<void> {
  try {
    await consentRequest("revoke", accessToken);
  } catch {
    // The local forget below still applies — a later verify fails closed.
  }
  clearStoredLocalComputerConsent();
}
