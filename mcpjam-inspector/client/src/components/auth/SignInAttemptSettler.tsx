import { useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { readSignInLoad, settleSignInOnLoad } from "@/lib/auth/signin-tracking";

// Module scope, not a ref: one settle per page load, even if the component
// remounts or StrictMode renders it twice.
let settledThisLoad = false;

/**
 * Settles a pending sign-in attempt once per page load. The URL is read on
 * the first render, before AuthKit's effect strips `code` from it. AuthKit
 * has no callback for "finished loading" (`onRedirectCallback` fires only on
 * success), so the attempt is settled once `isLoading` turns false. That is
 * also after PostHog has initialized. A successful return that navigates away
 * is settled earlier, in `onRedirectCallback`.
 */
export function SignInAttemptSettler({ redirectUri }: { redirectUri: string }) {
  const { isLoading, user } = useAuth();
  const [load] = useState(() =>
    readSignInLoad(window.location.href, redirectUri),
  );
  const signedIn = user != null;
  useEffect(() => {
    if (isLoading || settledThisLoad) return;
    settledThisLoad = true;
    settleSignInOnLoad(load, signedIn);
  }, [isLoading, load, signedIn]);
  return null;
}
