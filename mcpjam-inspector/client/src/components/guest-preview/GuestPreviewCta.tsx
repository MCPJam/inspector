/**
 * The one way out of a gated screen for a visitor with no account.
 *
 * Slots into {@link GatedFeaturePreview}'s CTA position. Owns the nudge
 * dialog's open state, so neither the preview nor the route has to carry a
 * boolean that only means something here.
 *
 * The CTA is named for the thing the visitor came to make. The dialog handles
 * sign-up and sign-in, and both return into that creation flow.
 */

import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { FeatureSignUpNudgeDialog } from "@/components/auth/FeatureSignUpNudgeDialog";
import { GATED_FEATURE_COPY, type GatedFeatureId } from "./feature-highlights";

export function GuestPreviewCta({ feature }: { feature: GatedFeatureId }) {
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const copy = GATED_FEATURE_COPY[feature];

  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* One CTA names the thing they came to make. The dialog handles
            sign-up/sign-in and returns both into that creation flow. */}
        <Button type="button" onClick={() => setNudgeOpen(true)}>
          {copy.ctaLabel}
        </Button>
      </div>
      <FeatureSignUpNudgeDialog
        feature={feature}
        isOpen={nudgeOpen}
        onClose={() => setNudgeOpen(false)}
      />
    </>
  );
}
