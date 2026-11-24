import { useState } from "react";
import { PlanChangeConfirmDialog } from "@/components/organization/PlanChangeConfirmDialog";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import { useUpgradeCheckout } from "@/hooks/use-upgrade-checkout";
import { track } from "@/lib/analytics";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";
import { canCheckoutPlan } from "@/lib/pricing-catalog";
import {
  SidebarPromptCard,
  sidebarPromptPage,
  useSidebarPromptShown,
} from "./sidebar-prompt-card";

const LOCATION = "sidebar_prompt";

/**
 * Free org, billing rights: opens the Plans page with the confirm dialog on
 * top, so closing it leaves the plan comparison in view. Stripe returns to the
 * Plans page and the app-wide upgrade return flow shows the paid-plan toast
 * once billing settles.
 */
export function SidebarProUpgradePrompt({
  organizationId,
}: {
  organizationId: string;
}) {
  const upgrade = useUpgradeCheckout({
    organizationId,
    origin: "sidebar",
    limitKind: "sidebar_prompt",
  });
  const { planCatalog } = useOrganizationBilling(organizationId);
  const [open, setOpen] = useState(false);
  const navigate = useAppNavigate();
  const entry = planCatalog?.plans.pro;
  const canBuyPro = (["monthly", "annual"] as const).some((interval) =>
    canCheckoutPlan(planCatalog, "pro", interval),
  );
  const available = !!entry && canBuyPro;
  useSidebarPromptShown(available ? "pro_upgrade" : null, organizationId);
  if (!available || !planCatalog) return null;

  const context = {
    location: LOCATION,
    organization_id: organizationId,
    target_plan: "pro",
    current_plan: upgrade.currentPlan,
  };

  return (
    <>
      <SidebarPromptCard
        kind="pro_upgrade"
        onClick={() => {
          track("upgrade_button_clicked", {
            ...context,
            prompt: "pro_upgrade",
            plan: upgrade.currentPlan,
            page: sidebarPromptPage(),
          });
          track("plans_upgrade_confirm_shown", {
            ...context,
            billing_interval: upgrade.interval,
          });
          navigate(buildOrganizationPath(organizationId, "plans"));
          setOpen(true);
        }}
      />
      {open ? (
        <PlanChangeConfirmDialog
          open
          onOpenChange={(next) => {
            if (next || upgrade.isStarting) return;
            track("plans_upgrade_confirm_dismissed", {
              ...context,
              billing_interval: upgrade.interval,
            });
            setOpen(false);
          }}
          plan="pro"
          entry={entry}
          currency={planCatalog.currency}
          interval={upgrade.interval}
          onIntervalChange={(interval) => {
            upgrade.setInterval(interval);
            track("plans_upgrade_confirm_interval_selected", {
              ...context,
              billing_interval: interval,
              price_cents: entry.prices[interval] ?? null,
            });
          }}
          annualDiscountPct={upgrade.annualDiscountPct}
          currentPlanName={
            planCatalog.plans[upgrade.currentPlan]?.displayName ??
            upgrade.currentPlan
          }
          seatQuantity={null}
          isNewSubscription
          isStarting={upgrade.isStarting}
          onConfirm={() => {
            track("plans_upgrade_confirm_submitted", {
              ...context,
              billing_interval: upgrade.interval,
              price_cents: entry.prices[upgrade.interval] ?? null,
            });
            void upgrade.start().then((result) => {
              if (result.shouldDismiss) setOpen(false);
            });
          }}
        />
      ) : null}
    </>
  );
}
