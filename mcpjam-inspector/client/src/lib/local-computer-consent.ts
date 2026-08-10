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

/**
 * Header that carries the consent capability on a local-engine chat turn. The
 * server reads it case-insensitively (`x-mcpjam-local-consent`); this is the
 * canonical casing. Kept out of the request BODY so it can't enter persisted
 * transcripts.
 */
export const LOCAL_CONSENT_HEADER = "X-MCPJam-Local-Consent";

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
 * never treats a token it can't read back as granted. A persist failure
 * releases the just-minted (now unpresentable) server capability,
 * best-effort and token-scoped.
 */
export async function grantLocalComputerConsent(): Promise<boolean> {
  const minted = await mintLocalComputerConsent();
  if (!minted) return false;
  const stored = persistLocalComputerConsent(minted);
  if (!stored) void revokeLocalComputerConsentOnServer(minted.token);
  return stored;
}

/**
 * Mint a single-use nonce for the local terminal WebSocket.
 *
 * Lives here (rather than in a terminal module) because it presents the SAME
 * consent capability, through the same `authFetch` path, to the same
 * `/api/mcp/computers` router — and because the consent token must never leak
 * into a URL or a persisted transcript, which the header keeps it out of.
 *
 * Throws with a user-presentable message on failure: `ComputerTerminal`'s
 * connect path renders it in the pane's error overlay, so a 403 (consent gone
 * stale) or a 503 (node-pty missing) reads as an explanation instead of a
 * silent dead socket.
 */
export async function mintLocalTerminalNonce(args: {
  projectId: string;
  consentToken: string | null;
}): Promise<string> {
  const response = await authFetch(
    "/api/mcp/computers/local-terminal-token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(args.consentToken
          ? { [LOCAL_CONSENT_HEADER]: args.consentToken }
          : {}),
      },
      body: JSON.stringify({ projectId: args.projectId }),
    },
  );
  const json = (await response.json().catch(() => null)) as {
    nonce?: unknown;
    error?: unknown;
  } | null;
  // Length-checked like `mintLocalComputerConsent` above: this value becomes a
  // WebSocket SUBPROTOCOL, and an empty/short one would fail as a silent dead
  // socket instead of the presentable error this function promises.
  if (!response.ok || typeof json?.nonce !== "string" || json.nonce.length < 16) {
    throw new Error(
      typeof json?.error === "string"
        ? json.error
        : "Could not open a terminal on this machine.",
    );
  }
  return json.nonce;
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
export async function revokeLocalComputerConsentOnServer(
  token: string | null = null,
): Promise<void> {
  try {
    await consentRequest("revoke", token != null ? { token } : undefined);
  } catch {
    // Local forget already happened; the server capability is best-effort.
  }
}
