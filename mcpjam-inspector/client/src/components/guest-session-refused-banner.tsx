import { useSyncExternalStore } from "react";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { AppBanner } from "@mcpjam/design-system/app-banner";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import {
  getGuestSessionRefusal,
  subscribeGuestSessionChanges,
} from "@/lib/guest-session";
import { guestSessionRefusalCopy } from "@/lib/guest-session-refusal-copy";

/**
 * Shown when the backend refused to CREATE a guest session: this network used
 * its daily allowance, or the deployment issues no guests at all. Either way
 * the refusal is deliberate and sign-in is the real next step, so say so.
 */
export function GuestSessionRefusedBanner() {
  const refusal = useSyncExternalStore(
    subscribeGuestSessionChanges,
    getGuestSessionRefusal,
    () => null,
  );
  const { user, signIn } = useInspectorAuth();

  if (!refusal || user) return null;

  const handleSignIn = () => {
    track("login_button_clicked", { location: "guest_session_refused" });
    captureAppSignInReturnPath();
    void Promise.resolve(signIn(permalinkSignInOptions())).catch(() => {});
  };

  return (
    <AppBanner
      data-testid="guest-session-refused-banner"
      className="fixed inset-x-0 top-0 z-50 backdrop-blur"
      actions={
        <Button size="sm" variant="outline" onClick={handleSignIn}>
          Sign in
        </Button>
      }
    >
      {guestSessionRefusalCopy(refusal.reason).banner}
    </AppBanner>
  );
}
