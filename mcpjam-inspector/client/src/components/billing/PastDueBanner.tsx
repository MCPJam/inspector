import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AppBanner } from "@mcpjam/design-system/app-banner";
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
      <AppBanner
        emphasis="quiet"
        data-testid="past-due-member-bar"
        onDismiss={() =>
          setDismissedOrganizationId(billingStatus.organizationId)
        }
      >
        Payment failed for {organizationName}. An owner has been asked to update
        the card.
      </AppBanner>
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
    <AppBanner
      data-testid="past-due-owner-banner"
      actions={
        <Button
          size="sm"
          variant="outline"
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
      }
    >
      <span className="font-medium">
        Payment failed for {organizationName}.
      </span>{" "}
      {graceEndsAt != null
        ? `Update your card by ${formatBillingDate(graceEndsAt)} to keep ${planName}.`
        : `Update your card to keep ${planName}.`}
    </AppBanner>
  );
}
