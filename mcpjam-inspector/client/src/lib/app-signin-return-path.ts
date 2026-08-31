/**
 * "Sign in, then put me back exactly where I was."
 *
 * The generic one. The scenario, billing, CLI, API-key and GitHub flows each
 * have their own stored path with its own precedence rules, and they keep
 * them: they encode more than a location (a checkout intent, a CLI handshake).
 * This one carries no intent at all — just the app route the visitor was
 * looking at when they were sent to WorkOS, which is now the only place the
 * project lives.
 *
 * Without it, signing in from `/p/B/evals/suite/X` returns to `/`, the app
 * resolves whatever project was last persisted, and the link the user
 * followed is gone. That is the same class of bug the canonical URL work
 * exists to end, one round trip later.
 *
 * Three defenses, because a stored redirect target is a real attack surface:
 *   - it must be an app-relative path (never `//evil.example`, never a
 *     `javascript:` URL, never a backslash the browser folds into a slash);
 *   - it is consumed exactly once — read and clear together;
 *   - it expires, so a path stored days ago in a long-lived tab cannot
 *     hijack an unrelated sign-in later.
 */
import { normalizeReturnTargetPath, routePaths } from "./app-navigation";
import { isAppRelativeTarget } from "./project-route";

const APP_SIGN_IN_RETURN_PATH_STORAGE_KEY = "mcpjam_app_signin_return_path_v1";

/**
 * How long a stored return path stays usable. Long enough for a slow SSO
 * round trip (IdP redirect, MFA, a password reset detour), short enough that
 * a tab left open overnight starts clean.
 */
export const APP_SIGN_IN_RETURN_PATH_TTL_MS = 30 * 60 * 1000;

interface StoredReturnPath {
  path: string;
  storedAt: number;
}

function isStorableReturnPath(path: string): boolean {
  if (!path || !path.startsWith("/")) return false;
  if (!isAppRelativeTarget(path)) return false;
  // The root and a bare query on it are not destinations worth restoring —
  // storing them only risks overriding a more specific flow's return path.
  if (path === routePaths.root || path.startsWith("/?")) return false;
  // Sign-in entry points. Restoring one of these would loop the user back
  // into the flow they just completed.
  const pathname = path.split(/[?#]/)[0];
  if (
    pathname === routePaths.callback ||
    pathname === routePaths.login ||
    pathname.startsWith("/oauth/callback")
  ) {
    return false;
  }
  return true;
}

/**
 * Store the current location as the post-sign-in destination.
 *
 * Call IMMEDIATELY before `signIn()`: WorkOS navigates away, so anything
 * scheduled instead of executed is lost.
 */
export function writeAppSignInReturnPath(
  path: string | null | undefined,
  now: number = Date.now()
): void {
  if (typeof sessionStorage === "undefined") return;
  const trimmed = path?.trim() ?? "";
  if (!isStorableReturnPath(trimmed)) return;
  try {
    const payload: StoredReturnPath = { path: trimmed, storedAt: now };
    sessionStorage.setItem(
      APP_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      JSON.stringify(payload)
    );
  } catch {
    // Ignore storage failures — the user lands on the default route.
  }
}

/** Capture the whole current URL (path + search + hash) before signing in. */
export function captureAppSignInReturnPath(): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  writeAppSignInReturnPath(`${pathname || "/"}${search || ""}${hash || ""}`);
}

export function readAppSignInReturnPath(
  now: number = Date.now()
): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(APP_SIGN_IN_RETURN_PATH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredReturnPath> | null;
    if (!parsed || typeof parsed.path !== "string") return null;
    if (
      typeof parsed.storedAt !== "number" ||
      now - parsed.storedAt > APP_SIGN_IN_RETURN_PATH_TTL_MS ||
      // A clock that moved backwards is not a reason to trust a stale path.
      now < parsed.storedAt - APP_SIGN_IN_RETURN_PATH_TTL_MS
    ) {
      return null;
    }
    if (!isStorableReturnPath(parsed.path)) return null;
    // Re-normalized on the way out, not just on the way in: this value has
    // been sitting in storage where anything on the origin could rewrite it.
    const normalized = normalizeReturnTargetPath(parsed.path, routePaths.root);
    return normalized === routePaths.root ? null : normalized;
  } catch {
    return null;
  }
}

export function clearAppSignInReturnPath(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(APP_SIGN_IN_RETURN_PATH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/** Read and clear in one step. A return path is used at most once. */
export function consumeAppSignInReturnPath(
  now: number = Date.now()
): string | null {
  const path = readAppSignInReturnPath(now);
  clearAppSignInReturnPath();
  return path;
}
