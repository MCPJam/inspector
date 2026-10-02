/**
 * A session that was signed out somewhere else (MJ-011).
 *
 * The gateway answers `401 SESSION_REVOKED` for an AuthKit session that has
 * been signed out — in another tab, on another device, or by an administrator
 * — while this tab still holds an access token for it. `/api/v1` carries the
 * same refusal as `401 UNAUTHORIZED` with `details.reason: "SESSION_REVOKED"`.
 * Convex reads such a session as no identity at all, with no code of its own,
 * so the gateway's answer is the signal this tab gets.
 *
 * The first such answer is reported here, ONCE per page load, to whichever
 * handler the app registered (`SignOutBoundary` signs the tab out). Every
 * later one is dropped: a page with a dozen requests in flight gets a dozen
 * refusals, and one sign-out.
 *
 * No store or UI imports here: `authFetch` depends on this module.
 */

export const SESSION_REVOKED_CODE = "SESSION_REVOKED";

/** True for the gateway's revoked-session refusal, in either envelope. */
export function isSessionRevokedBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { code, details } = body as { code?: unknown; details?: unknown };
  if (code === SESSION_REVOKED_CODE) return true;
  return (
    code === "UNAUTHORIZED" &&
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === SESSION_REVOKED_CODE
  );
}

/**
 * True when `response` is that refusal. Reads a CLONE, so the caller still
 * gets an unread body, and never throws: a body that will not parse is simply
 * not the refusal.
 */
export async function isSessionRevokedResponse(
  response: Response,
): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    if (typeof response.clone !== "function") return false;
    return isSessionRevokedBody(await response.clone().json());
  } catch {
    return false;
  }
}

type SessionRevokedHandler = () => void;

let handler: SessionRevokedHandler | null = null;
let notified = false;
let pending = false;

function run(next: SessionRevokedHandler): void {
  try {
    next();
  } catch {
    // The handler signs out; if it cannot, the requests keep failing as they
    // did before, which is no worse than not having one.
  }
}

/** Report the refusal. Only the first call on a page load does anything. */
export function notifySessionRevoked(): void {
  if (notified) return;
  notified = true;
  if (handler) run(handler);
  else pending = true;
}

/**
 * Register the one handler. A refusal that arrived before registration is
 * delivered now. Returns the unregister function.
 */
export function setSessionRevokedHandler(
  next: SessionRevokedHandler,
): () => void {
  handler = next;
  if (pending) {
    pending = false;
    run(next);
  }
  return () => {
    if (handler === next) handler = null;
  };
}

/** Test-only: forget the latch and the handler. */
export function resetSessionRevokedForTests(): void {
  handler = null;
  notified = false;
  pending = false;
}
