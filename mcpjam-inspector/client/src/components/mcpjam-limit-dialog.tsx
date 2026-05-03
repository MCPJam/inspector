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
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { readStoredActiveOrganizationId } from "@/lib/active-organization-storage";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

export function MCPJamLimitDialog() {
  const isOpen = useMCPJamLimitDialogStore((s) => s.isOpen);
  const intent = useMCPJamLimitDialogStore((s) => s.intent);
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

  useEffect(() => {
    setAuthStatus(isLoading ? "loading" : user ? "signedIn" : "guest");
    // Auth flipped to signed-in while the guest variant was open (e.g. user
    // signed in from another tab). Render guards already hide it; close so
    // the store stops reporting an open dialog.
    if (user && intent === "guest" && isOpen) close();
  }, [close, intent, isLoading, isOpen, setAuthStatus, user]);

  if (isLoading) return null;

  // Resolve which org's billing page to redirect to. Prefer the
  // localStorage-persisted active org for this user; fall back to the
  // most-recent org from the membership list.
  const resolveBillingOrgId = (): string | null => {
    if (!user) return null;
    const stored = readStoredActiveOrganizationId(user.id);
    if (stored) return stored;
    return sortedOrganizations[0]?._id ?? null;
  };

  const handleTopUp = () => {
    const orgId = resolveBillingOrgId();
    close();
    if (!orgId) return;
    // The hash router strips ?... before resolving the route, so the
    // `topup=open` flag is invisible to navigation but visible to the
    // billing page on mount.
    window.location.hash = `organizations/${orgId}/billing?topup=open`;
  };

  const handleBYOK = () => {
    const orgId = resolveBillingOrgId();
    close();
    if (!orgId) return;
    window.location.hash = `organizations/${orgId}/models`;
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
              <DialogTitle>You've used today's free guest limit</DialogTitle>
              <DialogDescription>
                Sign in to get{" "}
                <strong className="text-foreground font-medium">10×</strong>{" "}
                daily usage.
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
              <DialogTitle>You've hit your daily credit limit</DialogTitle>
              <DialogDescription>
                {billingUiEnabled
                  ? "Top up or bring your own key to keep chatting on MCPJam's models without waiting for tomorrow's reset."
                  : "Bring your own key to keep chatting on MCPJam's models without waiting for tomorrow's reset."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleBYOK}>
                Bring your own key
              </Button>
              {billingUiEnabled && (
                <Button type="button" onClick={handleTopUp}>
                  Top up
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
