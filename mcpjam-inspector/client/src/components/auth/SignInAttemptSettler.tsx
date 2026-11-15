import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { readSignInLoad, settleSignInOnLoad } from "@/lib/auth/signin-tracking";

/**
 * Settles a pending sign-in attempt once per page load. The URL is read on
 * the first render, before AuthKit's effect strips `code` from it, and the
 * attempt is settled after AuthKit finishes loading, which is also after
 * PostHog has initialized.
 */
export function SignInAttemptSettler({ redirectUri }: { redirectUri: string }) {
  const { isLoading, user } = useAuth();
  const [load] = useState(() =>
    readSignInLoad(window.location.href, redirectUri),
  );
  const settled = useRef(false);
  useEffect(() => {
    if (isLoading || settled.current) return;
    settled.current = true;
    settleSignInOnLoad(load, user != null);
  }, [isLoading, load, user]);
  return null;
}
