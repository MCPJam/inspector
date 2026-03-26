import { Button } from "@/components/ui/button";
import type { BillingFeatureName, OrganizationPlan } from "@/hooks/useOrganizationBilling";
import {
  formatBillingFeatureName,
  formatPlanName,
} from "@/lib/billing-entitlements";

interface PremiumnessLockedPanelProps {
  feature: BillingFeatureName;
  upgradePlan: OrganizationPlan | null;
  canManageBilling: boolean;
  onViewBilling: () => void;
}

export function PremiumnessLockedPanel({
  feature,
  upgradePlan,
  canManageBilling,
  onViewBilling,
}: PremiumnessLockedPanelProps) {
  const featureName = formatBillingFeatureName(feature);
  const targetPlan = formatPlanName(upgradePlan ?? "starter");

  return (
    <div
      className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="premiumness-locked-panel"
    >
      <div className="max-w-md space-y-2">
        <h2 className="text-lg font-semibold">{featureName} is locked</h2>
        <p className="text-sm text-muted-foreground">
          {featureName} is not included on your current plan
          {upgradePlan ? ` — upgrade to ${targetPlan} or higher to unlock.` : "."}
        </p>
        {!canManageBilling ? (
          <p className="text-sm text-muted-foreground">
            Ask an organization owner to upgrade from Organization settings.
          </p>
        ) : null}
      </div>
      {canManageBilling ? (
        <Button type="button" onClick={onViewBilling}>
          View billing options
        </Button>
      ) : null}
    </div>
  );
}
