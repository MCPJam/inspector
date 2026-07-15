/**
 * Guest Session Manager
 *
 * Manages short-lived guest bearer tokens for unauthenticated visitors. The
 * persistent guest identity now lives in an HttpOnly cookie set by the
 * backend; this module keeps the bearer token in module memory only and
 * fetches a fresh one whenever needed.
 *
 * The legacy `mcpjam_guest_session_v1` localStorage entry is read once and
 * forwarded to the server as `legacyToken` so existing guests can be
 * migrated. It is deleted only after a definitive server response so
 * transient failures do not strand old guests on a new identity.
 */

import { NON_PROD_LOCKDOWN } from "@/lib/config";

declare global {
  interface Window {
    // Server-injected guest bootstrap blob (Pillar 1). Read once at module
    // eval before React renders, then deleted. NEVER written to localStorage —
    // the bearer stays in module memory only, like a client-minted session.
    __MCP_GUEST_BOOTSTRAP__?: {
      token: string;
      guestId?: string;
      expiresAt: number;
    };
  }
}

const LEGACY_STORAGE_KEY = "mcpjam_guest_session_v1";
// Persistent, non-secret marker recording that a guest was actually
// *activated* (drove Convex auth as a guest), keyed by guestId. It is not the
// bearer; it survives the guest→sign-in navigation so the promotion path can
// tell a genuine guest from an incidental document bootstrap.
const GUEST_ACTIVATED_STORAGE_KEY = "mcpjam_guest_activated";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

type GuestSessionMode = "lookup_or_create" | "lookup_only";

interface GuestSession {
  guestId: string;
  token: string;
  expiresAt: number;
}

let cachedSession: GuestSession | null = null;
let inFlightRequest: Promise<GuestSession | null> | null = null;
let inFlightLookupOnly: Promise<GuestSession | null> | null = null;
let forceRefreshInFlight: Promise<GuestSession | null> | null = null;
let legacyMigrationConsumed = false;
// Bumped whenever the cache is invalidated externally (clearGuestSession,
// forceRefreshGuestSession). Captured before each fetch so a late response
// from a request that was started before the bump cannot resurrect a stale
// token by overwriting cachedSession.
let sessionGeneration = 0;
const sessionListeners = new Set<() => void>();

function setCachedSession(session: GuestSession | null): void {
  const previousGuestId = cachedSession?.guestId ?? null;
  cachedSession = session;
  const nextGuestId = cachedSession?.guestId ?? null;
  if (previousGuestId !== nextGuestId) {
    for (const listener of sessionListeners) {
      listener();
    }
  }
}

export function subscribeGuestSessionChanges(
  listener: () => void,
): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

/**
 * Mark the guest identified by `guestId` as *activated* — i.e. it actually
 * drove Convex auth as a guest (not just an incidental document bootstrap).
 * Persisted (localStorage, non-secret) so the marker survives the guest →
 * WorkOS sign-in navigation. The promotion path reads this to distinguish a
 * genuine guest from an incidental cookie.
 */
export function markGuestActivated(guestId: string): void {
  if (!guestId) return;
  try {
    if (localStorage.getItem(GUEST_ACTIVATED_STORAGE_KEY) !== guestId) {
      localStorage.setItem(GUEST_ACTIVATED_STORAGE_KEY, guestId);
    }
  } catch {
    // ignore (private mode / storage disabled)
  }
}

/**
 * Returns true when the guest identified by `guestId` was previously
 * activated as a guest (`markGuestActivated`). Used by the promotion path to
 * gate `getGuestPromotionProof()` on real activation, not mere cookie
 * presence.
 */
export function isGuestActivated(guestId: string | null | undefined): boolean {
  if (!guestId) return false;
  try {
    return localStorage.getItem(GUEST_ACTIVATED_STORAGE_KEY) === guestId;
  } catch {
    return false;
  }
}

/**
 * Read the server-injected `window.__MCP_GUEST_BOOTSTRAP__` blob once at
 * module load (before the first React render), validate it, and seed the
 * in-memory cache so the lazy `useState` initializers in
 * `unified-convex-auth.ts` / `use-actor-key.ts` see a non-null token on the
 * very first render. One-shot: the global is deleted after reading; the bearer
 * is never persisted to localStorage.
 */
function seedFromBootstrap(): void {
  if (typeof window === "undefined") return;
  const blob = window.__MCP_GUEST_BOOTSTRAP__;
  try {
    delete window.__MCP_GUEST_BOOTSTRAP__;
  } catch {
    window.__MCP_GUEST_BOOTSTRAP__ = undefined;
  }
  if (!blob) return;
  // Require a non-empty guestId: a seeded session with an empty guestId would
  // read as "resolved" (token present) yet leave the promotion path unable to
  // identify the guest — activation and incidental-revoke would both no-op,
  // stranding the document-minted cookie. If the server omitted guestId, skip
  // the seed and fall back to the client lookup path (which fills guestId).
  if (
    typeof blob.token !== "string" ||
    blob.token.length === 0 ||
    typeof blob.expiresAt !== "number" ||
    typeof blob.guestId !== "string" ||
    blob.guestId.length === 0
  ) {
    return;
  }
  // Honor the same expiry buffer the rest of the cache uses so we never seed a
  // token that's about to expire.
  if (blob.expiresAt - EXPIRY_BUFFER_MS <= Date.now()) {
    return;
  }
  cachedSession = {
    guestId: blob.guestId,
    token: blob.token,
    expiresAt: blob.expiresAt,
  };
}

// Runs at import time (main.tsx imports this module transitively before
// root.render), so the seed is in place before the first render.
seedFromBootstrap();

function consumeLegacyToken(): string | null {
  if (legacyMigrationConsumed) return null;
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

function deleteLegacyToken(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
  legacyMigrationConsumed = true;
}

class GuestSessionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuestSessionRequestError";
  }
}

/**
 * Returns the parsed session on success, `null` on a definitive "no guest"
 * miss (HTTP 204/404), and throws `GuestSessionRequestError` on transient
 * failures (network error, non-ok response, malformed body) so callers can
 * distinguish "no guest exists" from "couldn't reach the server."
 */
async function requestGuestSession(
  mode: GuestSessionMode,
  legacyToken: string | null,
): Promise<GuestSession | null> {
  // Non-prod lockdown disables guest sessions server-side (returns 403). Skip
  // the network call entirely so the console isn't flooded with errors and
  // callers settle quickly into the unauthenticated state.
  if (NON_PROD_LOCKDOWN) {
    return null;
  }

  const body: Record<string, unknown> = { mode };
  if (legacyToken) body.legacyToken = legacyToken;

  let response: Response;
  try {
    response = await fetch("/api/web/guest-session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new GuestSessionRequestError(
      error instanceof Error ? error.message : "network error",
    );
  }

  // 204 is the server's explicit "no guest exists" signal — definitive miss.
  // 404 is ambiguous (route missing/misrouted in a deployment) and may be
  // transient, so treat it as an error rather than discarding the legacy
  // migration token.
  if (response.status === 204) {
    if (legacyToken) deleteLegacyToken();
    return null;
  }

  if (!response.ok) {
    throw new GuestSessionRequestError(
      `guest-session request failed: ${response.status} ${response.statusText}`,
    );
  }

  let session: GuestSession;
  try {
    session = (await response.json()) as GuestSession;
  } catch (error) {
    throw new GuestSessionRequestError(
      `guest-session response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    typeof session?.token !== "string" ||
    typeof session?.expiresAt !== "number"
  ) {
    throw new GuestSessionRequestError(
      "guest-session response missing token or expiresAt",
    );
  }

  if (legacyToken) deleteLegacyToken();
  return session;
}

/**
 * Get or create a guest session. Returns a cached session if one is in
 * memory and not within the expiry buffer; otherwise issues a single
 * `lookup_or_create` request and dedupes concurrent callers.
 */
export async function getOrCreateGuestSession(): Promise<GuestSession | null> {
  if (cachedSession && cachedSession.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return cachedSession;
  }

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const legacyToken = consumeLegacyToken();
  const generation = sessionGeneration;
  // Initialized to a placeholder so TS sees a definite assignment; the
  // real value is assigned synchronously below before the IIFE's finally
  // (which references currentInFlight via closure) can run.
  let currentInFlight: Promise<GuestSession | null> = Promise.resolve(null);

  currentInFlight = (async () => {
    try {
      const session = await requestGuestSession(
        "lookup_or_create",
        legacyToken,
      );
      if (session && generation === sessionGeneration) {
        setCachedSession(session);
      }
      return session;
    } catch (error) {
      console.error("Failed to create guest session:", error);
      return null;
    } finally {
      if (inFlightRequest === currentInFlight) {
        inFlightRequest = null;
      }
    }
  })();
  inFlightRequest = currentInFlight;

  return inFlightRequest;
}

/**
 * Get just the guest bearer token string, or null if unavailable.
 */
export async function getGuestBearerToken(): Promise<string | null> {
  const session = await getOrCreateGuestSession();
  return session?.token ?? null;
}

/**
 * Synchronous read of the in-memory cached guest session. Returns null when no
 * session has been resolved yet — callers that need to bootstrap actor-scoped
 * storage should also `getOrCreateGuestSession()` to populate the cache so the
 * next render returns the real id.
 */
export function getCachedGuestSession(): GuestSession | null {
  if (cachedSession && cachedSession.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return cachedSession;
  }
  return null;
}

/**
 * Look up an existing guest bearer token without creating a new guest.
 * Used by post-login flows (e.g. registry-star merge) so signing in does
 * not accidentally mint a brand-new guest just to merge nothing.
 *
 * Returns `null` only when the server confirms there is no existing guest
 * (HTTP 204/404). Throws `GuestSessionRequestError` on transient failures
 * so callers can retry rather than treating a network blip as "no guest."
 */
export async function getExistingGuestBearerToken(): Promise<string | null> {
  if (cachedSession && cachedSession.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return cachedSession.token;
  }

  if (inFlightLookupOnly) {
    const session = await inFlightLookupOnly;
    return session?.token ?? null;
  }

  const legacyToken = consumeLegacyToken();
  const generation = sessionGeneration;
  let currentLookup: Promise<GuestSession | null> = Promise.resolve(null);

  currentLookup = (async () => {
    try {
      const session = await requestGuestSession("lookup_only", legacyToken);
      if (session && generation === sessionGeneration) {
        setCachedSession(session);
      }
      return session;
    } finally {
      if (inFlightLookupOnly === currentLookup) {
        inFlightLookupOnly = null;
      }
    }
  })();
  inFlightLookupOnly = currentLookup;

  const session = await inFlightLookupOnly;
  return session?.token ?? null;
}

/**
 * Resolve the `guestId` of the guest backed by the current cookie WITHOUT
 * minting a new guest. Prefers the in-memory cache (the common same-tab
 * guest→sign-in case) and otherwise issues a single `lookup_only`. Returns
 * null when there is no existing guest cookie or on transient failure.
 *
 * Used by the promotion path to look up the activation marker for the cookie
 * actually present, so an incidental document-bootstrap cookie (never
 * activated) is not promoted.
 */
export async function getExistingGuestId(): Promise<string | null> {
  const cached = getCachedGuestSession();
  if (cached?.guestId) {
    return cached.guestId;
  }
  try {
    await getExistingGuestBearerToken();
  } catch {
    return null;
  }
  return getCachedGuestSession()?.guestId ?? null;
}

/**
 * Drop the in-memory guest session cache. The HttpOnly cookie remains set
 * on the browser, so the next call to `getOrCreateGuestSession` continues
 * to resolve the same guest identity.
 *
 * Bumps the session generation so any in-flight request that was started
 * before the clear cannot resurrect a stale token by writing into
 * `cachedSession` after it resolves.
 */
export function clearGuestSession(): void {
  sessionGeneration += 1;
  setCachedSession(null);
  inFlightRequest = null;
  inFlightLookupOnly = null;
  forceRefreshInFlight = null;
}

/**
 * Revoke the browser's guest session: tells the server to mark the
 * cookie-backed session row as revoked and to clear the HttpOnly cookie
 * via Set-Cookie. Used by the post-WorkOS-login flow so a signed-in user
 * who later signs out cannot resurrect the previous guest identity by
 * replaying the cookie.
 *
 * Idempotent: returns false if no cookie was present or revocation
 * failed; returns true on success. Always also clears the in-memory
 * cache so subsequent guest-token reads in this tab fall through to
 * a fresh `lookup_or_create` call.
 */
export async function revokeGuestSessionAndCookie(): Promise<boolean> {
  let revoked = false;
  try {
    const response = await fetch("/api/web/guest-session/revoke", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (response.ok) {
      try {
        const body = (await response.json()) as { revoked?: unknown };
        revoked = body?.revoked === true;
      } catch {
        revoked = false;
      }
    }
  } catch (error) {
    console.error("Failed to revoke guest session:", error);
  } finally {
    clearGuestSession();
  }
  return revoked;
}

/**
 * Fetch a short-lived (5-minute) JWT that authorizes a single guest→WorkOS
 * promotion. The session bearer (`getExistingGuestBearerToken`) is the
 * wrong token for this job — it's served on every guest API call and lives
 * 24h, so a stolen bearer would give an attacker a long window to absorb
 * a victim's guest projects by submitting it as `guestProofJwt`.
 *
 * Promotion proofs are minted on-demand right before sign-in, carry a
 * distinct `purpose` claim, and are accepted only by `users:ensureUser`'s
 * promotion path. Not cached: each promotion is a one-shot operation.
 *
 * Returns null if no guest cookie is present (nothing to promote) or on
 * any transient failure — callers should treat null as "no promotion this
 * sign-in" and let the user proceed as a fresh authed account.
 */
export async function getGuestPromotionProof(): Promise<string | null> {
  try {
    const response = await fetch("/api/web/guest-session/promotion-proof", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });

    if (response.status === 204) return null;
    if (!response.ok) return null;

    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token.length > 0
      ? body.token
      : null;
  } catch (error) {
    console.error("Failed to fetch guest promotion proof:", error);
    return null;
  }
}

/**
 * Force-refresh the guest bearer token. Drops the in-memory cache and
 * fetches a new JWT bound to the cookie-backed guest. Deduplicates
 * concurrent force-refresh calls.
 */
export async function forceRefreshGuestSession(): Promise<string | null> {
  if (forceRefreshInFlight) {
    const session = await forceRefreshInFlight;
    return session?.token ?? null;
  }

  sessionGeneration += 1;
  const generation = sessionGeneration;
  cachedSession = null;
  inFlightRequest = null;
  inFlightLookupOnly = null;

  forceRefreshInFlight = (async () => {
    try {
      const legacyToken = consumeLegacyToken();
      const session = await requestGuestSession(
        "lookup_or_create",
        legacyToken,
      );
      if (session && generation === sessionGeneration) {
        setCachedSession(session);
      }
      return session;
    } catch (error) {
      console.error("Failed to refresh guest session:", error);
      return null;
    }
  })();

  try {
    const session = await forceRefreshInFlight;
    return session?.token ?? null;
  } finally {
    forceRefreshInFlight = null;
  }
}
