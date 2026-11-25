/**
 * "Confirm the account once I land back from sign-up."
 *
 * The sidebar's guest card starts WorkOS sign-up, a full-page navigation, so
 * the confirmation has to survive the reload: no payload, consumed once, and
 * it expires.
 */
const PENDING_SIGNUP_TOAST_STORAGE_KEY = "mcpjam:pending-signup-toast-v1";

export const PENDING_SIGNUP_TOAST_TTL_MS = 30 * 60 * 1000;

/** Call IMMEDIATELY before `signUp()`: WorkOS navigates away. */
export function markPendingSignUpToast(now: number = Date.now()): void {
  try {
    sessionStorage.setItem(
      PENDING_SIGNUP_TOAST_STORAGE_KEY,
      JSON.stringify({ storedAt: now }),
    );
  } catch {
    // Storage unavailable: they still land signed in, just without the toast.
  }
}

/** Read and clear in one step, expired or not. */
/** Returns when the sign-up click happened, or null when no live marker exists. */
export function consumePendingSignUpToast(
  now: number = Date.now(),
): number | null {
  let storedAt: unknown = null;
  try {
    const raw = sessionStorage.getItem(PENDING_SIGNUP_TOAST_STORAGE_KEY);
    sessionStorage.removeItem(PENDING_SIGNUP_TOAST_STORAGE_KEY);
    storedAt = raw ? (JSON.parse(raw) as { storedAt?: unknown }).storedAt : null;
  } catch {
    return null;
  }
  return typeof storedAt === "number" &&
    Math.abs(now - storedAt) <= PENDING_SIGNUP_TOAST_TTL_MS
    ? storedAt
    : null;
}
