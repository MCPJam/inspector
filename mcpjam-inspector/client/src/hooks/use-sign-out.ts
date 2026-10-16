import { useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { showSignOutScreen } from "@/stores/sign-out-store";
import {
  markSignOutInProgress,
  SIGN_OUT_REQUEST_TIMEOUT_MS,
} from "@/lib/auth/sign-out-latch";
import { pauseQueriesBeforeAuthClear } from "@/lib/auth/pause-queries-before-auth-clear";
import { startSessionRevocation } from "@/lib/auth/revoke-session";

type AuthExitCleanup = () => void | Promise<void>;

// Module scope rather than context: the Terms dialog that signs out renders
// above App, which owns the connected servers this cleanup disconnects.
let authExitCleanup: AuthExitCleanup | null = null;

/**
 * Registers the teardown every sign-out runs before the session is cleared,
 * such as disconnecting the runtime servers App holds open.
 */
export function useAuthExitCleanup(cleanup: AuthExitCleanup): void {
  useEffect(() => {
    authExitCleanup = cleanup;
    return () => {
      if (authExitCleanup === cleanup) authExitCleanup = null;
    };
  }, [cleanup]);
}

/**
 * Signs the current WorkOS user out of this tab and revokes the session.
 *
 * The registered auth-exit cleanup runs after the sign-out screen is up and
 * before the session is cleared. Sign-out proceeds whether it returns, throws
 * or rejects: a failed cleanup must not leave the user signed in.
 */
export function useSignOut() {
  const { signOut, getAccessToken } = useAuth();

  const signOutOfWorkOs = () => {
    const returnTo = window.location.origin;
    // Keep our branded screen visible while WorkOS clears its cookies.
    // Bound the request so a failed or missing token cannot strand this tab.
    let timeout: ReturnType<typeof setTimeout>;
    void Promise.race([
      Promise.resolve().then(() => signOut({ returnTo, navigate: false })),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, SIGN_OUT_REQUEST_TIMEOUT_MS);
      }),
    ])
      // The navigation below clears this tab either way.
      .catch((error: unknown) => {
        console.debug("[sign-out] WorkOS sign-out request failed", error);
      })
      .finally(() => {
        clearTimeout(timeout);
        window.location.assign(returnTo);
      });
  };

  const finishSignOut = () => {
    // Before `signOut()`, never after: authkit's refresh timer can fire on the
    // next tick, and an unlatched failure would redirect this tab to the login
    // page on top of the logout navigation below. See `sign-out-latch`.
    markSignOutInProgress();
    // And the gate: `signOut()` empties the WorkOS user and Convex drops its
    // identity on that render, re-running anything still subscribed without
    // one. See `pause-queries-before-auth-clear`.
    pauseQueriesBeforeAuthClear();
    // Revoke the session server-side with the token about to be discarded,
    // so it stops working everywhere now rather than when it expires. Bounded
    // and never rejects; see `revoke-session`.
    const leave = () => signOutOfWorkOs();
    void startSessionRevocation(getAccessToken).then(leave, leave);
  };

  return () => {
    showSignOutScreen();

    let cleanupResult: void | Promise<void>;
    try {
      cleanupResult = authExitCleanup?.();
    } catch (error) {
      // Cleanup is best effort; signing out matters more than its failure.
      console.debug("[sign-out] cleanup before sign-out failed", error);
      finishSignOut();
      return;
    }

    if (
      cleanupResult &&
      typeof (cleanupResult as Promise<void>).finally === "function"
    ) {
      void (cleanupResult as Promise<void>)
        // Same as the synchronous throw above.
        .catch((error: unknown) => {
          console.debug("[sign-out] cleanup before sign-out failed", error);
        })
        .finally(finishSignOut);
      return;
    }

    finishSignOut();
  };
}
