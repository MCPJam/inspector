import type { ReactNode } from "react";
import { BillingUpsellGate } from "@/components/billing/BillingUpsellGate";
import type { ResolvedBillingGate } from "@/lib/billing-gates";

interface BillingGateSurfaceProps {
  gate: ResolvedBillingGate;
  loadingFallback?: ReactNode;
  children: ReactNode;
  onNavigateToBilling?: (organizationId: string) => void;
}

export function BillingGateSurface({
  gate,
  loadingFallback = null,
  children,
  onNavigateToBilling,
}: BillingGateSurfaceProps) {
  if (gate.isLoading) {
    return <>{loadingFallback}</>;
  }

  if (gate.isDenied && gate.gate.feature) {
    return (
      <BillingUpsellGate
        feature={gate.gate.feature}
        currentPlan={gate.currentPlan}
        upgradePlan={gate.upgradePlan}
        canManageBilling={gate.canManageBilling}
        onNavigateToBilling={() => {
          if (gate.organizationId) {
            onNavigateToBilling?.(gate.organizationId);
          }
        }}
      />
    );
  }

  return <>{children}</>;
}
