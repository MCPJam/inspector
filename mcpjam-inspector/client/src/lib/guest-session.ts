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

const LEGACY_STORAGE_KEY = "mcpjam_guest_session_v1";
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
        cachedSession = session;
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
        cachedSession = session;
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
  cachedSession = null;
  inFlightRequest = null;
  inFlightLookupOnly = null;
  forceRefreshInFlight = null;
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
        cachedSession = session;
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
