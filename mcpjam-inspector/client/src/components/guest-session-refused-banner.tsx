import { useSyncExternalStore } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { CircleAlert } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import {
  getGuestSessionRefusal,
  subscribeGuestSessionChanges,
} from "@/lib/guest-session";

/**
 * Shown when the backend refused to CREATE a guest session because this
 * network already minted its daily allowance (per-IP cap, mcpjam-backend
 * #1391/#1392). Before this the refusal surfaced as a generic 503, the
 * bootstrap retried it four times, reported it as an error, and the page
 * rendered as signed-out with no explanation. The refusal is deliberate and
 * sign-in is the real next step, so say so.
 */
export function GuestSessionRefusedBanner() {
  const refusal = useSyncExternalStore(
    subscribeGuestSessionChanges,
    getGuestSessionRefusal,
    () => null,
  );
  const { user, signIn } = useAuth();

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
        Too many guest sessions from your network today. Sign in to continue.
      </span>
      <Button size="sm" variant="outline" onClick={handleSignIn}>
        Sign in
      </Button>
    </div>
  );
}
