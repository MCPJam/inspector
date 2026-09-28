import { useAuth } from "@workos-inc/authkit-react";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";

/**
 * The click behind every "Sign in" an insight surface offers after the backend
 * refused an anonymous caller (`SIGN_IN_REQUIRED`), where it would otherwise
 * offer Retry.
 *
 * Same wiring as every other sign-in control in the app: `useAuth().signIn`,
 * the tracked `login_button_clicked`, and the captured return path, so the
 * user lands back on the run they were reading.
 */
export function useInsightSignIn(location: string): () => void {
  const { signIn } = useAuth();
  return () => {
    track("login_button_clicked", { location });
    captureAppSignInReturnPath();
    signIn(permalinkSignInOptions());
  };
}
