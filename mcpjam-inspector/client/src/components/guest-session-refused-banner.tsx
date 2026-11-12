import { useSyncExternalStore } from "react";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { CircleAlert } from "lucide-react";
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
    <div
      role="alert"
      data-testid="guest-session-refused-banner"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm backdrop-blur"
    >
      <CircleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <span className="text-foreground">
        {guestSessionRefusalCopy(refusal.reason).banner}
      </span>
      <Button size="sm" variant="outline" onClick={handleSignIn}>
        Sign in
      </Button>
    </div>
  );
}
