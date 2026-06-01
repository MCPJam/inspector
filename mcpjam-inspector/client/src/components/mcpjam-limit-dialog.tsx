import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useEffect } from "react";
import {
  canManageOrgCredits,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";
import { readStoredActiveOrganizationId } from "@/lib/active-organization-storage";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useAppNavigate } from "@/lib/app-navigation";

export function MCPJamLimitDialog() {
  const isOpen = useMCPJamLimitDialogStore((s) => s.isOpen);
  const intent = useMCPJamLimitDialogStore((s) => s.intent);
  const limitOrganizationId = useMCPJamLimitDialogStore(
    (s) => s.organizationId
  );
  const close = useMCPJamLimitDialogStore((s) => s.close);
  const setAuthStatus = useMCPJamLimitDialogStore((s) => s.setAuthStatus);
  const { user, isLoading, signIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  // Look up the user's orgs as a fallback in case there is no stored
  // active-org for this user (e.g. brand-new sign-in). Sorted most-recent
  // first by useOrganizationQueries.
  const { sortedOrganizations } = useOrganizationQueries({ isAuthenticated });
  // Gate the Top up CTA on the same PostHog flag the rest of the billing
  // UI uses. When the flag is off, the modal hides Top up and shows only
  // the BYOK button — avoids dead-ending users on deployments where Stripe
  // isn't wired up yet.
  const billingUiEnabled =
    useFeatureFlagEnabled("billing-entitlements-ui") === true;
  const appNavigate = useAppNavigate();

  useEffect(() => {
    setAuthStatus(isLoading ? "loading" : user ? "signedIn" : "guest");
    // Auth flipped to signed-in while the guest variant was open (e.g. user
    // signed in from another tab). Render guards already hide it; close so
    // the store stops reporting an open dialog.
    if (user && intent === "guest" && isOpen) close();
  }, [close, intent, isLoading, isOpen, setAuthStatus, user]);

  if (isLoading) return null;

  // Resolve which org's billing page to redirect to. Prefer the org that
  // actually hit the limit; fall back to local active org / recent org.
  const resolveBillingOrgId = (): string | null => {
    if (!user) return null;
    if (limitOrganizationId) return limitOrganizationId;
    const stored = readStoredActiveOrganizationId(user.id);
    if (stored) return stored;
    return sortedOrganizations[0]?._id ?? null;
  };

  // Only owners/admins/creators can buy credits (mirrors the backend gate).
  // Members instead see an "ask org admin" hint so they don't dead-end on a
  // button the checkout action would reject. While the org membership is
  // still resolving (no match yet) we stay optimistic and show the buy
  // button — `handleTopUp` already no-ops until an org id is available, so an
  // actual admin never sees a premature "ask admin" flash.
  const billingOrgId = resolveBillingOrgId();
  const billingOrg = billingOrgId
    ? sortedOrganizations.find((org) => org._id === billingOrgId) ?? null
    : null;
  const isKnownNonManager = billingOrg ? !canManageOrgCredits(billingOrg) : false;
  const canBuyCredits = billingUiEnabled && !isKnownNonManager;

  const handleTopUp = () => {
    const orgId = resolveBillingOrgId();
    // Don't dismiss the modal until we know we can route the user — on a
    // fresh sign-in the membership query may still be in flight, in which
    // case closing now would drop them out of the upsell silently.
    if (!orgId) return;
    close();
    // The router strips ?... before resolving the route, so the
    // `topup=open` flag is invisible to navigation but visible to the
    // billing page on mount.
    appNavigate(`/organizations/${orgId}/billing?topup=open`);
  };

  const handleBYOK = () => {
    const orgId = resolveBillingOrgId();
    if (!orgId) return;
    close();
    appNavigate(`/organizations/${orgId}/models`);
  };

  // Guest variant — only renders for unauthenticated users.
  const showGuestDialog = !user && intent === "guest" && isOpen;
  // Top-up variant — only renders for signed-in users.
  const showTopupDialog = !!user && intent === "topup" && isOpen;

  return (
    <>
      {showGuestDialog && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>You've used up your free guest credits.</DialogTitle>
              <DialogDescription>
                Sign in to get{" "}
                <strong className="text-foreground font-medium">15×</strong> the
                free credits.
              </DialogDescription>
            </DialogHeader>
            <Button onClick={() => signIn()} className="w-full">
              Sign in
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {showTopupDialog && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>You've hit the org free credit limit</DialogTitle>
              <DialogDescription data-testid="limit-dialog-description">
                {isKnownNonManager
                  ? "Ask your org admin to top up credits."
                  : canBuyCredits
                    ? "Top up or bring your own key to allow your org to keep using MCPJam."
                    : "Bring your own key to keep chatting on MCPJam's models without waiting for tomorrow's reset."}
              </DialogDescription>
            </DialogHeader>
            {/* Non-managers get no CTAs — just the "ask your org admin" copy.
                Managers (and the dev billing-off fallback) keep BYOK, plus a
                Top up button when credit purchase is available. */}
            {!isKnownNonManager ? (
              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleBYOK}>
                  Bring your own key
                </Button>
                {canBuyCredits ? (
                  <Button type="button" onClick={handleTopUp}>
                    Top up
                  </Button>
                ) : null}
              </DialogFooter>
            ) : null}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
