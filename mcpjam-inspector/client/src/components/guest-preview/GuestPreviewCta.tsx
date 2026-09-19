/**
 * The way out of a gated screen for a visitor with no account.
 *
 * Slots into {@link GatedFeaturePreview}'s CTA position. Owns the nudge
 * dialog's open state, so neither the preview nor the route has to carry a
 * boolean that only means something here.
 *
 * "Create free account" opens the nudge rather than going straight to WorkOS.
 * The extra step is the point: the sheet is where the feature makes its case
 * for why an account is needed at all, and a visitor who is still deciding
 * gets that argument instead of an immediate redirect off the product.
 * "Sign in" skips it — someone who already has an account has nothing to be
 * persuaded of.
 */

import { useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@mcpjam/design-system/button";
import { FeatureSignUpNudgeDialog } from "@/components/auth/FeatureSignUpNudgeDialog";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import {
  GATED_FEATURE_COPY,
  type GatedFeatureId,
} from "./feature-highlights";

export function GuestPreviewCta({ feature }: { feature: GatedFeatureId }) {
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const { signIn } = useAuth();
  const location = GATED_FEATURE_COPY[feature].analyticsLocation;

  const handleSignIn = () => {
    track("login_button_clicked", { location });
    // Before the navigation, always — this is what returns them to the tab
    // they were reading rather than the app's front door.
    captureAppSignInReturnPath();
    signIn(permalinkSignInOptions());
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* "Create account", not "Create free account" (Vig, in review): the
            two buttons here mirror the pair already in the top nav for a
            signed-out visitor, and matching their labels means the page reads
            as one offer rather than two competing ones. */}
        <Button type="button" onClick={() => setNudgeOpen(true)}>
          Create account
        </Button>
        <Button type="button" variant="outline" onClick={handleSignIn}>
          Sign in
        </Button>
      </div>
      {/* "Free to start. No card." removed: another pricing claim nobody
          made, and now actively misleading, since what bounds these features
          is credits rather than a plan. */}
      <FeatureSignUpNudgeDialog
        feature={feature}
        isOpen={nudgeOpen}
        onClose={() => setNudgeOpen(false)}
      />
    </>
  );
}
