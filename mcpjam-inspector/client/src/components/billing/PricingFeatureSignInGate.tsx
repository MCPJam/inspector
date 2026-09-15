import type { ReactNode } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { GuestSignInMessage } from "@/components/auth/GuestSignInMessage";
/** Independent of pricing offers and the warning-pill experiment; defaults off. */
export function PricingFeatureSignInGate({
  feature,
  children,
}: {
  feature: string;
  children: ReactNode;
}) {
  const enabled =
    useFeatureFlagEnabled("pricing-feature-signin-required") === true;
  if (!enabled) return children;
  return <SignedInFeature feature={feature}>{children}</SignedInFeature>;
}

function SignedInFeature({
  feature,
  children,
}: {
  feature: string;
  children: ReactNode;
}) {
  const member = useIsMemberActor();
  if (member === undefined) return <p role="status">Loading account…</p>;
  if (!member)
    return (
      <GuestSignInMessage
        message={`Sign in to use ${feature}.`}
        location="pricing_feature_signin"
      />
    );
  return children;
}
