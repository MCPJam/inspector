import { Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";

const SandboxBuilderExperience = lazy(
  () => import("@/components/sandboxes/builder/SandboxBuilderExperience"),
);

interface SandboxesTabProps {
  workspaceId: string | null;
}

/**
 * Billing-related Convex failures from sandbox mutations use getBillingErrorMessage
 * in CreateSandboxDialog, SandboxEditor, and SandboxBuilderView.
 */
export function SandboxesTab({ workspaceId }: SandboxesTabProps) {
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
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SandboxBuilderExperience workspaceId={workspaceId} />
    </Suspense>
  );
}
