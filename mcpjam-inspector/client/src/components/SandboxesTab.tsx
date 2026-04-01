import { Suspense, lazy, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { BillingGateSurface } from "@/components/billing/BillingGateSurface";
import { BILLING_GATES, useWorkspaceBillingGate } from "@/lib/billing-gates";
import { clearBuilderSession } from "@/lib/sandbox-session";

const SandboxBuilderExperience = lazy(
  () => import("@/components/sandboxes/builder/SandboxBuilderExperience"),
);

interface SandboxesTabProps {
  workspaceId: string | null;
}

function SandboxesLoadingState() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Billing-related Convex failures from sandbox mutations use getBillingErrorMessage
 * in CreateSandboxDialog, SandboxEditor, and SandboxBuilderView.
 */
export function SandboxesTab({ workspaceId }: SandboxesTabProps) {
  const sandboxGate = useWorkspaceBillingGate({
    workspaceId,
    gate: BILLING_GATES.sandboxes,
  });

  useEffect(() => {
    if (sandboxGate.isDenied) {
      clearBuilderSession();
    }
  }, [sandboxGate.isDenied]);

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
        <SandboxBuilderExperience workspaceId={workspaceId} />
      </Suspense>
    </BillingGateSurface>
  );
}
