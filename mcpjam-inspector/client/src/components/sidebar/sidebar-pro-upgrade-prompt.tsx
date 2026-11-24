import { useEffect, useSyncExternalStore } from "react";
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

// The Plans page hides the sidebar, so the confirm dialog's open state lives
// outside the card and the dialog renders from app scope.
let confirmOrganizationId: string | null = null;
const listeners = new Set<() => void>();

function setConfirmOrganizationId(next: string | null) {
  confirmOrganizationId = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useProCheckout(organizationId: string) {
  const upgrade = useUpgradeCheckout({
    organizationId,
    origin: "sidebar",
    limitKind: "sidebar_prompt",
  });
  const { planCatalog } = useOrganizationBilling(organizationId);
  const entry = planCatalog?.plans.pro;
  const canBuyPro = (["monthly", "annual"] as const).some((interval) =>
    canCheckoutPlan(planCatalog, "pro", interval),
  );
  const context = {
    location: LOCATION,
    organization_id: organizationId,
    target_plan: "pro",
    current_plan: upgrade.currentPlan,
  };
  return {
    upgrade,
    planCatalog,
    entry: canBuyPro ? entry : undefined,
    context,
  };
}

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
  const { upgrade, planCatalog, entry, context } =
    useProCheckout(organizationId);
  const navigate = useAppNavigate();
  const available = !!entry && !!planCatalog;
  useSidebarPromptShown(available ? "pro_upgrade" : null, organizationId);
  if (!available) return null;

  return (
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
        setConfirmOrganizationId(organizationId);
      }}
    />
  );
}

export function SidebarProConfirmDialog() {
  const organizationId = useSyncExternalStore(
    subscribe,
    () => confirmOrganizationId,
    () => null,
  );
  if (!organizationId) return null;
  return <ProConfirmDialog organizationId={organizationId} />;
}

function ProConfirmDialog({ organizationId }: { organizationId: string }) {
  const { upgrade, planCatalog, entry, context } =
    useProCheckout(organizationId);
  // Back from the Plans page leaves the offer behind with it.
  useEffect(() => {
    const plansPath = buildOrganizationPath(organizationId, "plans");
    const closeOffPlans = () => {
      if (window.location.pathname !== plansPath) {
        setConfirmOrganizationId(null);
      }
    };
    window.addEventListener("popstate", closeOffPlans);
    return () => window.removeEventListener("popstate", closeOffPlans);
  }, [organizationId]);
  if (!entry || !planCatalog) return null;

  return (
    <PlanChangeConfirmDialog
      open
      onOpenChange={(next) => {
        if (next || upgrade.isStarting) return;
        track("plans_upgrade_confirm_dismissed", {
          ...context,
          billing_interval: upgrade.interval,
        });
        setConfirmOrganizationId(null);
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
          if (result.shouldDismiss) setConfirmOrganizationId(null);
        });
      }}
    />
  );
}
