import { Button } from "@mcpjam/design-system/button";
import type {
  BillingFeatureName,
  OrganizationPlan,
} from "@/hooks/useOrganizationBilling";
import {
  formatBillingFeatureName,
  formatPlanName,
} from "@/lib/billing-entitlements";

const FEATURE_DESCRIPTIONS: Partial<Record<BillingFeatureName, string>> = {
  evals:
    "Create test suites, run them in the playground, and inspect traces to validate your MCP servers.",
  cicd: "Wire eval runs into your CI/CD pipeline so regressions are caught before they ship.",
  sandboxes:
    "Publish hosted chat experiences with a fixed model, system prompt, and server set for demos and feedback.",
};

export interface BillingUpsellGateProps {
  feature: BillingFeatureName;
  /** Plan the org is effectively on (for context copy). */
  currentPlan: OrganizationPlan;
  /** Minimum plan that unlocks this feature, when known. */
  upgradePlan: OrganizationPlan | null;
  canManageBilling: boolean;
  onNavigateToBilling: () => void;
}

export function BillingUpsellGate({
  feature,
  currentPlan,
  upgradePlan,
  canManageBilling,
  onNavigateToBilling,
}: BillingUpsellGateProps) {
  const featureName = formatBillingFeatureName(feature);
  const description =
    FEATURE_DESCRIPTIONS[feature] ??
    "This capability is not included on your current plan.";
  const currentLabel = formatPlanName(currentPlan);
  const includedLine = upgradePlan
    ? `Included in ${formatPlanName(upgradePlan)} and above.`
    : `Not included on ${currentLabel}.`;

  return (
    <div
      className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="billing-upsell-gate"
    >
      <div className="max-w-md space-y-2 rounded-md border border-border/70 p-6 text-left shadow-sm">
        <h2 className="text-lg font-semibold">{featureName}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
        <p className="text-sm text-muted-foreground">{includedLine}</p>
        {canManageBilling ? (
          <Button
            type="button"
            className="mt-3 w-full sm:w-auto"
            onClick={onNavigateToBilling}
          >
            Upgrade
          </Button>
        ) : (
          <p className="pt-2 text-sm font-medium text-foreground">
            Ask your admin to upgrade
          </p>
        )}
      </div>
    </div>
  );
}
