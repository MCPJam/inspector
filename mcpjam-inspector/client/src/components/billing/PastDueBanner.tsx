import { useState } from "react";
import { CircleAlert, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import type { OrganizationBillingStatus } from "@/hooks/useOrganizationBilling";
import { buildOrganizationPath } from "@/lib/app-navigation";
import {
  canShowSubscriptionNotices,
  formatPlanName,
} from "@/lib/billing-entitlements";
import {
  openBillingUrlInNewTab,
  reserveBillingTab,
} from "@/lib/billing-portal-tab";
import { formatBillingDate } from "@/components/organization/OrganizationCurrentPlanPanel";

export type PastDueBannerStatus = Pick<
  OrganizationBillingStatus,
  | "organizationId"
  | "organizationName"
  | "plan"
  | "source"
  | "billingConfigured"
  | "canManageBilling"
  | "paymentState"
  | "paymentGraceEndsAt"
>;

/**
 * App-wide notice for an organization whose subscription payment failed.
 * Billing managers get the fix; everyone else gets a quiet, dismissible bar.
 * It renders only from the live billing status, so it clears for the whole
 * organization as soon as Stripe reports the payment went through.
 */
export function PastDueBanner({
  billingStatus,
  viewerRole,
  hidden = false,
  openPortal,
  isOpeningPortal,
}: {
  billingStatus: PastDueBannerStatus | null | undefined;
  /** The viewer's organization role; organization guests see nothing. */
  viewerRole?: string;
  hidden?: boolean;
  openPortal: (returnUrl: string) => Promise<string>;
  isOpeningPortal: boolean;
}) {
  const [dismissedOrganizationId, setDismissedOrganizationId] = useState<
    string | null
  >(null);
  const isPastDue =
    billingStatus != null &&
    canShowSubscriptionNotices(billingStatus) &&
    billingStatus.paymentState === "past_due";

  // A dismissal lasts only while this payment stays failed: recovery clears
  // it, so a later failure shows the bar again.
  if (
    dismissedOrganizationId !== null &&
    billingStatus?.organizationId === dismissedOrganizationId &&
    !isPastDue
  ) {
    setDismissedOrganizationId(null);
  }

  if (!billingStatus || !isPastDue || hidden || viewerRole === "guest") {
    return null;
  }

  const organizationName = billingStatus.organizationName;

  if (!billingStatus.canManageBilling) {
    if (dismissedOrganizationId === billingStatus.organizationId) return null;
    return (
      <div
        role="status"
        data-testid="past-due-member-bar"
        className="flex shrink-0 items-center gap-2 border-b border-border/60 py-1 pl-4 pr-3 text-xs text-muted-foreground"
      >
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-warning"
        />
        <span className="text-pretty">
          {`Payment failed for ${organizationName}. An owner has been asked to update the card.`}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss"
          className="ml-auto size-6 shrink-0"
          onClick={() =>
            setDismissedOrganizationId(billingStatus.organizationId)
          }
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  const planName = formatPlanName(billingStatus.plan);
  const graceEndsAt = billingStatus.paymentGraceEndsAt ?? null;

  const handleUpdateCard = async () => {
    const reservedTab = reserveBillingTab();
    try {
      const portalUrl = await openPortal(
        `${window.location.origin}${buildOrganizationPath(
          billingStatus.organizationId,
          "billing",
        )}`,
      );
      if (!(await openBillingUrlInNewTab(portalUrl, reservedTab))) {
        toast.error(
          "Your browser blocked the billing tab. Allow pop-ups, then select Update card again.",
        );
      }
    } catch {
      reservedTab?.close();
      toast.error("Couldn't open billing. Select Update card to try again.");
    }
  };

  return (
    <div
      role="alert"
      data-testid="past-due-owner-banner"
      className="flex shrink-0 items-center gap-3 border-b border-l-2 border-b-warning/30 border-l-warning bg-warning/10 py-2 pl-3.5 pr-3 text-sm"
    >
      <CircleAlert className="size-4 shrink-0 text-warning" />
      <span className="text-pretty text-foreground">
        {graceEndsAt != null
          ? `Payment failed for ${organizationName}. Update your card by ${formatBillingDate(graceEndsAt)} to keep ${planName}.`
          : `Payment failed for ${organizationName}. Update your card to keep ${planName}.`}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto shrink-0"
        disabled={!billingStatus.billingConfigured || isOpeningPortal}
        onClick={() => void handleUpdateCard()}
      >
        {isOpeningPortal ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            Opening…
          </>
        ) : (
          "Update card"
        )}
      </Button>
    </div>
  );
}
