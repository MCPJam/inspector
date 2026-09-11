import { useEffect, useRef } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { markPendingInviteDialog } from "@/lib/pending-invite-dialog";

const LOCATION = "invite_signup_nudge";

/**
 * The guest half of the sidebar's "Invite team members" CTA.
 *
 * ShareProjectDialog cannot render for a guest — it needs a WorkOS user, an
 * organization, and a shared project — so the CTA opens this nudge instead.
 * Both buttons do the same three things, in an order that matters:
 *   1. markPendingInviteDialog — the intent that survives the WorkOS reload,
 *      so the sidebar can open the real invite dialog when they land back;
 *   2. captureAppSignInReturnPath + permalinkSignInOptions — the standard
 *      pair that returns them to this exact page after auth;
 *   3. signIn/signUp — the navigation itself.
 * "Create free account" is the primary (the CTA exists to convert guests);
 * "Sign in" stays for the guest who already has an account on another
 * device. Both reopen the invite dialog on return — the task they came for
 * is the same either way.
 */
export function InviteTeamSignUpDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { signIn, signUp } = useAuth();

  // One impression per opening, not per render — StrictMode double-invokes
  // effects, so the ref is scoped to the open transition rather than mount.
  const impressionTrackedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      impressionTrackedRef.current = false;
      return;
    }
    if (impressionTrackedRef.current) return;
    impressionTrackedRef.current = true;
    track("invite_signup_nudge_shown", { location: LOCATION });
  }, [isOpen]);

  const handleDismiss = () => {
    onClose();
    track("invite_signup_nudge_dismissed", { location: LOCATION });
  };

  const prepareSignInReturn = () => {
    markPendingInviteDialog();
    // Remember where they were, so WorkOS returns them to this page rather
    // than the app's front door.
    captureAppSignInReturnPath();
  };

  const handleSignUp = () => {
    track("sign_up_button_clicked", { location: LOCATION });
    prepareSignInReturn();
    signUp(permalinkSignInOptions());
  };

  const handleSignIn = () => {
    track("login_button_clicked", { location: LOCATION });
    prepareSignInReturn();
    signIn(permalinkSignInOptions());
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) handleDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite your team to MCPJam</DialogTitle>
          <DialogDescription>
            Create a free account to share projects and invite teammates to
            debug, test, and build on MCP servers together.
          </DialogDescription>
        </DialogHeader>
        {/* Primary is first in the DOM so Radix's focus scope lands on it —
            Enter converts instead of signing in — and flex-row-reverse
            restores the usual order with the primary on the right. */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row-reverse">
          <Button onClick={handleSignUp} className="flex-1">
            Create free account
          </Button>
          <Button variant="outline" onClick={handleSignIn} className="flex-1">
            Sign in
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
