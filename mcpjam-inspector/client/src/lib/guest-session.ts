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
 * migrated, and is deleted as soon as the server has had a chance to
 * accept it.
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

function consumeLegacyToken(): string | null {
  if (legacyMigrationConsumed) return null;
  legacyMigrationConsumed = true;
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
}

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
    console.error("Failed to create guest session:", error);
    if (legacyToken) deleteLegacyToken();
    return null;
  }

  if (legacyToken) deleteLegacyToken();

  if (response.status === 204 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    console.error(
      "Failed to create guest session:",
      response.status,
      response.statusText,
    );
    return null;
  }

  try {
    const session = (await response.json()) as GuestSession;
    if (
      typeof session?.token !== "string" ||
      typeof session?.expiresAt !== "number"
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
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

  inFlightRequest = (async () => {
    try {
      const session = await requestGuestSession(
        "lookup_or_create",
        legacyToken,
      );
      if (session) cachedSession = session;
      return session;
    } finally {
      inFlightRequest = null;
    }
  })();

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

  inFlightLookupOnly = (async () => {
    try {
      const session = await requestGuestSession("lookup_only", legacyToken);
      if (session) cachedSession = session;
      return session;
    } finally {
      inFlightLookupOnly = null;
    }
  })();

  const session = await inFlightLookupOnly;
  return session?.token ?? null;
}

/**
 * Drop the in-memory guest session cache. The HttpOnly cookie remains set
 * on the browser, so the next call to `getOrCreateGuestSession` continues
 * to resolve the same guest identity.
 */
export function clearGuestSession(): void {
  cachedSession = null;
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

  cachedSession = null;
  inFlightRequest = null;

  forceRefreshInFlight = (async () => {
    const legacyToken = consumeLegacyToken();
    const session = await requestGuestSession(
      "lookup_or_create",
      legacyToken,
    );
    if (session) cachedSession = session;
    return session;
  })();

  try {
    const session = await forceRefreshInFlight;
    return session?.token ?? null;
  } finally {
    forceRefreshInFlight = null;
  }
}
