/**
 * Guest Session Manager
 *
 * Manages guest bearer tokens for unauthenticated visitors in hosted mode.
 * Tokens are stored in localStorage and automatically refreshed when expired.
 */

const STORAGE_KEY = "mcpjam_guest_session_v1";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

interface GuestSession {
  guestId: string;
  token: string;
  expiresAt: number;
}

let inFlightRequest: Promise<GuestSession | null> | null = null;
let forceRefreshInFlight: Promise<GuestSession | null> | null = null;
let sessionGeneration = 0;

function readFromStorage(): GuestSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GuestSession;
  } catch {
    return null;
  }
}

function writeToStorage(session: GuestSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

/**
 * Get or create a guest session. If a valid session exists in localStorage,
 * it is reused. Otherwise, a new one is fetched from the server.
 *
 * Uses raw fetch (not authFetch) to avoid circular dependency.
 */
export async function getOrCreateGuestSession(): Promise<GuestSession | null> {
  // Check localStorage first
  const existing = readFromStorage();
  if (existing && existing.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return existing;
  }

  // Deduplicate concurrent requests
  if (inFlightRequest) {
    return inFlightRequest;
  }

  const generation = sessionGeneration;
  inFlightRequest = (async () => {
    try {
      const response = await fetch("/api/web/guest-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        console.error(
          "Failed to create guest session:",
          response.status,
          response.statusText,
        );
        return null;
      }

      const session: GuestSession = await response.json();
      // Only write if no force-refresh has invalidated this generation
      if (sessionGeneration === generation) {
        writeToStorage(session);
      }
      return session;
    } catch (error) {
      console.error("Failed to create guest session:", error);
      return null;
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
 * Returns the currently persisted guest token without triggering a network
 * request. Used by retry logic to detect whether a failing hosted request
 * was sent with the guest bearer even if hosted context classification is stale.
 */
export function peekStoredGuestToken(): string | null {
  return readFromStorage()?.token ?? null;
}

/**
 * Clear the guest session from localStorage.
 * Call this when the user logs in with WorkOS.
 */
export function clearGuestSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Force-refresh the guest session by clearing the cached token
 * and fetching a new one from the server. Used when the server
 * rejects a token that hasn't expired client-side (e.g., after
 * a server restart with new signing keys).
 *
 * Deduplicates concurrent force-refresh calls (e.g., when multiple
 * parallel requests all get 401 and each triggers a retry).
 */
export async function forceRefreshGuestSession(): Promise<string | null> {
  // If a force-refresh is already in flight, piggyback on it
  // instead of clearing its state and starting yet another request.
  if (forceRefreshInFlight) {
    const session = await forceRefreshInFlight;
    return session?.token ?? null;
  }

  clearGuestSession();
  sessionGeneration++;
  inFlightRequest = null;

  forceRefreshInFlight = getOrCreateGuestSession();
  try {
    const session = await forceRefreshInFlight;
    return session?.token ?? null;
  } finally {
    forceRefreshInFlight = null;
  }
}
