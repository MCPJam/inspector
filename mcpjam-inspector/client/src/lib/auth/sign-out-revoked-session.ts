import {
  isSignOutInProgress,
  markSignOutInProgress,
  SIGN_OUT_REQUEST_TIMEOUT_MS,
} from "@/lib/auth/sign-out-latch";
import { pauseQueriesBeforeAuthClear } from "@/lib/auth/pause-queries-before-auth-clear";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { showSignOutScreen, useSignOutStore } from "@/stores/sign-out-store";

/**
 * Sign this tab out after the gateway reported its session revoked
 * (`session-revoked.ts`), the way the sidebar's Sign out does: latch, show the
 * sign-out screen, end the AuthKit session without navigating, then return to
 * the app's front door as a signed-out visitor.
 *
 * The session is already revoked server-side, so there is nothing to revoke
 * here. A sign-out already under way — this tab's own, whose revocation is
 * what the gateway is reporting — is left to finish on its own.
 */

export const SESSION_ENDED_MESSAGE = "Your session has ended. Signing you out…";

/**
 * The sign-out screen stays up at least this long, so its message can be read
 * before the page reloads. Together with the bounded logout request it stays
 * below `SIGN_OUT_SUPPRESSION_WINDOW_MS`, like every other sign-out.
 */
export const SESSION_ENDED_NOTICE_MS = 1_500;

/**
 * A second revoked-session sign-out this soon after the first, in the same
 * tab, is not repeated. The first one reloaded the page signed out; the only
 * way to be back here is a logout that did not take, and reloading again would
 * go round in a loop. The tab shows the signed-out banner instead.
 */
export const REPEAT_SIGN_OUT_GUARD_MS = 60_000;

const SIGNED_OUT_AT_KEY = "mcpjam.sessionRevokedSignOutAt";

function readSignedOutAt(): number | null {
  try {
    const raw = window.sessionStorage.getItem(SIGNED_OUT_AT_KEY);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function writeSignedOutAt(at: number): void {
  try {
    window.sessionStorage.setItem(SIGNED_OUT_AT_KEY, String(at));
  } catch {
    // Storage unavailable: the page-load latch still holds.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SignOut = (options: {
  returnTo?: string;
  navigate: false;
}) => void | Promise<void>;

export async function signOutRevokedSession(
  signOut: SignOut,
  now: number = Date.now(),
): Promise<void> {
  if (useSignOutStore.getState().isSigningOut || isSignOutInProgress(now)) {
    return;
  }
  const previous = readSignedOutAt();
  if (
    previous !== null &&
    now >= previous &&
    now - previous < REPEAT_SIGN_OUT_GUARD_MS
  ) {
    useSessionRefreshStore.getState().notifyFailure("signed_out");
    return;
  }
  writeSignedOutAt(now);

  // Before `signOut()`, never after — see `sign-out-latch`.
  markSignOutInProgress();
  showSignOutScreen(SESSION_ENDED_MESSAGE);

  const returnTo = window.location.origin;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.all([
    Promise.race([
      Promise.resolve()
        .then(() => {
          // Before `signOut()` empties the WorkOS user, after which Convex
          // drops its identity and re-runs anything still subscribed without
          // one. In the microtask, not above: this function can run from a
          // render-phase read (the query tracer reports what `useQuery`
          // reads), where `flushSync` cannot flush.
          pauseQueriesBeforeAuthClear();
          return signOut({ returnTo, navigate: false });
        })
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SIGN_OUT_REQUEST_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer)),
    wait(SESSION_ENDED_NOTICE_MS),
  ]);
  window.location.assign(returnTo);
}
