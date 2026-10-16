import { useEffect } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { getInvalidOrganizationRouteNavigationTarget } from "@/lib/app-navigation";

interface UnavailableOrganizationDialogProps {
  isAuthenticated: boolean;
  routeTab: string;
  routeOrganizationId?: string;
  isLoadingOrganizations: boolean;
  hasRouteOrganization: boolean;
  isDeletionPending: boolean;
  isDeleted: boolean;
  isSeatPending: boolean;
  accountEmail?: string;
  onContinue: () => void;
}

export function UnavailableOrganizationDialog({
  isAuthenticated,
  routeTab,
  routeOrganizationId,
  isLoadingOrganizations,
  hasRouteOrganization,
  isDeletionPending,
  isDeleted,
  isSeatPending,
  accountEmail,
  onContinue,
}: UnavailableOrganizationDialogProps) {
  // The person who deleted the org already knows why it is gone; access
  // advice would only confuse them, so their fallback stays silent.
  const isSilentFallback = !routeOrganizationId || isDeleted;
  const navigationTarget =
    isAuthenticated && !isDeletionPending
      ? getInvalidOrganizationRouteNavigationTarget({
          routeTab,
          routeOrganizationId,
          isLoadingOrganizations,
          hasRouteOrganization,
        })
      : null;

  useEffect(() => {
    if (navigationTarget && isSilentFallback) onContinue();
  }, [navigationTarget, isSilentFallback, onContinue]);

  if (!navigationTarget || isSilentFallback) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onContinue()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>This organization isn&apos;t available</DialogTitle>
          <DialogDescription>
            {accountEmail && <>You&apos;re signed in as {accountEmail}. </>}
            {isSeatPending
              ? "Your seat is awaiting payment. Ask an organization admin to complete the payment."
              : "Sign in with the email address that received the invitation, or ask an organization admin to invite this account."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onContinue}>Go to your projects</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
