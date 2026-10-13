/**
 * The sign-up sheet a guest opens from the Swarms or User Testing preview
 * (REEV-10).
 *
 * Sibling of {@link InviteTeamSignUpDialog}, and deliberately not a
 * generalisation of it. That one exists to reopen the invite dialog after the
 * WorkOS round trip, so it plants `markPendingInviteDialog()` and the sidebar
 * consumes the marker on return. A gated tab needs no marker: the return path
 * is the creation flow named by its CTA, or, on a shared swarm or study
 * permalink, that permalink itself. Folding both into one component
 * would mean a "should I leave a marker" flag whose two settings have
 * nothing else in common.
 *
 * What it does share is the ordering that matters on every button:
 *   1. writeAppSignInReturnPath(returnPath) — remember where to come back to,
 *      in sessionStorage, before WorkOS navigates away;
 *   2. signUp/signIn(permalinkSignInOptions(returnPath)) — the navigation itself.
 * Get those backwards and the user lands on the app's front door instead.
 *
 * "Create free account" is primary because the whole surface exists to convert
 * a visitor with no account; "Sign in" stays for someone signed in on another
 * device. Both return to the same place — the task they came for is the same
 * either way.
 */

import { useEffect, useRef } from "react";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { JamIllustration } from "@/components/billing/JamIllustration";
import { track } from "@/lib/analytics";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { writeAppSignInReturnPath } from "@/lib/app-signin-return-path";
import {
  GATED_FEATURE_COPY,
  type GatedFeatureId,
} from "@/components/guest-preview/feature-highlights";

/**
 * The creation flow from the tab root or `/new`; anywhere deeper is a shared
 * swarm or study permalink, and the recipient should land back on it with its
 * `?project=` scope intact.
 */
function signInReturnPath(createPath: string): string {
  const { pathname, search, hash } = window.location;
  const path = pathname.replace(/\/+$/, "");
  const listPath = createPath.replace(/\/new$/, "");
  if (path === listPath || path === createPath) return createPath;
  return `${pathname}${search}${hash}`;
}

export function FeatureSignUpNudgeDialog({
  feature,
  isOpen,
  onClose,
}: {
  feature: GatedFeatureId;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { signIn, signUp } = useInspectorAuth();
  const copy = GATED_FEATURE_COPY[feature];
  const location = copy.analyticsLocation;

  // One impression per OPENING, not per render — scoped to the open transition
  // rather than to mount, because StrictMode double-invokes effects and the
  // dialog stays mounted across open/close cycles.
  const impressionTracked = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      impressionTracked.current = false;
      return;
    }
    if (impressionTracked.current) return;
    impressionTracked.current = true;
    track("guest_feature_nudge_shown", { location, feature });
  }, [isOpen, location, feature]);

  const handleDismiss = () => {
    onClose();
    track("guest_feature_nudge_dismissed", { location, feature });
  };

  const handleSignUp = () => {
    track("sign_up_button_clicked", { location });
    const returnPath = signInReturnPath(copy.createPath);
    writeAppSignInReturnPath(returnPath);
    signUp(permalinkSignInOptions(returnPath));
  };

  const handleSignIn = () => {
    track("login_button_clicked", { location });
    const returnPath = signInReturnPath(copy.createPath);
    writeAppSignInReturnPath(returnPath);
    signIn(permalinkSignInOptions(returnPath));
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) handleDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <JamIllustration />
        {/* No bullet list. It once carried three sell lines including "run
            your first swarm on us, no card needed", a pricing promise nobody
            had made. The title and one sentence about what the run teaches
            are what is left. */}
        <DialogHeader>
          <DialogTitle>{copy.nudge.title}</DialogTitle>
          <DialogDescription>{copy.nudge.body}</DialogDescription>
        </DialogHeader>
        {/* Primary first in the DOM so Radix's focus scope lands on it — Enter
            creates the account instead of signing in — and flex-row-reverse
            restores the usual visual order. Same trick, same reason, as
            InviteTeamSignUpDialog. */}
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
