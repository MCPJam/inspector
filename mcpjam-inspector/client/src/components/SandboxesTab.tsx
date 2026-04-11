import { Suspense, lazy, useEffect } from "react";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import {
  getBillingUpsellCtaLabel,
  getBillingUpsellTeaser,
} from "@/lib/billing-upsell";
import { Loader2 } from "lucide-react";
import { BillingGateSurface } from "@/components/billing/BillingGateSurface";
import { BILLING_GATES, useWorkspaceBillingGate } from "@/lib/billing-gates";
import { clearBuilderSession } from "@/lib/sandbox-session";

const SandboxBuilderExperience = lazy(
  () => import("@/components/sandboxes/builder/SandboxBuilderExperience"),
);

interface SandboxesTabProps {
  workspaceId: string | null;
  organizationId: string | null;
  isBillingContextPending?: boolean;
}

function SandboxesLoadingState({
  testId = "sandboxes-loading-state",
  message = "Loading sandboxes...",
}: {
  testId?: string;
  message?: string;
}) {
  return (
    <div
      className="flex h-full min-h-[320px] items-center justify-center p-8"
      data-testid={testId}
    >
      <div className="text-center">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

/**
 * Billing-related Convex failures from sandbox mutations use getBillingErrorMessage
 * in CreateSandboxDialog, SandboxEditor, and SandboxBuilderView.
 */
export function SandboxesTab({
  workspaceId,
  organizationId,
  isBillingContextPending = false,
}: SandboxesTabProps) {
  const sandboxGate = useWorkspaceBillingGate({
    workspaceId,
    organizationId,
    gate: BILLING_GATES.sandboxes,
  });
  const sandboxCreationGate = useWorkspaceBillingGate({
    workspaceId,
    organizationId,
    gate: BILLING_GATES.sandboxCreation,
  });
  const { planCatalog } = useOrganizationBilling(sandboxGate.organizationId, {
    workspaceId,
  });
  const createSandboxUpsell =
    sandboxCreationGate.isDenied && sandboxCreationGate.denialMessage
      ? {
          title: "Need more sandboxes?",
          message: sandboxCreationGate.denialMessage,
          teaser: getBillingUpsellTeaser({
            planCatalog,
            upgradePlan: sandboxCreationGate.upgradePlan,
            intent: "sandboxes",
          }),
          canManageBilling: sandboxCreationGate.canManageBilling,
          ctaLabel: getBillingUpsellCtaLabel(sandboxCreationGate.upgradePlan),
          onNavigateToBilling: () => {
            if (sandboxCreationGate.organizationId) {
              window.location.hash = `organizations/${sandboxCreationGate.organizationId}/billing`;
            }
          },
        }
      : null;

  useEffect(() => {
    if (sandboxGate.isDenied) {
      clearBuilderSession();
    }
  }, [sandboxGate.isDenied]);

  if (isBillingContextPending) {
    return (
      <SandboxesLoadingState
        testId="sandboxes-billing-context-pending"
        message="Checking your organization access..."
      />
    );
  }

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a workspace to manage sandboxes.
        </p>
      </div>
    );
  }

  return (
    <BillingGateSurface
      gate={sandboxGate}
      loadingFallback={<SandboxesLoadingState />}
      onNavigateToBilling={(organizationId) => {
        window.location.hash = `organizations/${organizationId}/billing`;
      }}
    >
      <Suspense fallback={<SandboxesLoadingState />}>
        <SandboxBuilderExperience
          workspaceId={workspaceId}
          isCreateSandboxDisabled={sandboxCreationGate.isDenied}
          isCreateSandboxLoading={sandboxCreationGate.isLoading}
          createSandboxUpsell={createSandboxUpsell}
        />
      </Suspense>
    </BillingGateSurface>
  );
}
