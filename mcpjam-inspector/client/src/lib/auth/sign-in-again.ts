import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { SIGN_OUT_REQUEST_TIMEOUT_MS } from "./sign-out-latch";

type SignOut = (options: { navigate: false }) => void | Promise<void>;
type SignIn = (options: ReturnType<typeof permalinkSignInOptions>) => unknown;

/**
 * The startup recovery card's "Sign in again".
 *
 * By the time startup is stuck, the failed refresh has usually already lost
 * the session: AuthKit's `signOut` then rejects with `NoSessionError` and
 * clears nothing. So ending the session is best effort, bounded by the usual
 * sign-out timeout, and sign-in opens whatever happens to it.
 *
 * The sign-out latch is deliberately not set. It resets the failure state to
 * idle for its whole window, which would take the recovery card down if
 * sign-in does not navigate away.
 */
export async function signInAgain({
  signOut,
  signIn,
}: {
  signOut: SignOut;
  signIn: SignIn;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => signOut({ navigate: false })),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SIGN_OUT_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // No session left to end, or the logout call failed. Signing in replaces
    // the session either way, so this is not an error the user can act on.
  } finally {
    clearTimeout(timer);
  }
  // Return here after WorkOS, not to the app's front door.
  captureAppSignInReturnPath();
  await signIn(permalinkSignInOptions());
}
