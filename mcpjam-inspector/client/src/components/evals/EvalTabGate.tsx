import type { ReactNode } from "react";
import { FlaskConical, GitBranch } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export type EvalTabGateVariant = "playground" | "ci";

export function EvalTabGate({
  variant,
  isLoading,
  isAuthenticated,
  user,
  workspaceId,
  children,
}: {
  variant: EvalTabGateVariant;
  isLoading: boolean;
  isAuthenticated: boolean;
  user: unknown;
  workspaceId: string | null | undefined;
  children: ReactNode;
}) {
  const Icon = variant === "playground" ? FlaskConical : GitBranch;

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">
              {variant === "playground" ? "Loading testing..." : "Loading..."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Icon}
          title={
            variant === "playground"
              ? "Sign in to use Testing"
              : "Sign in to view CI runs"
          }
          description={
            variant === "playground"
              ? "Create an account or sign in to explore cases and investigate runs."
              : "Create an account or sign in to view SDK-ingested evaluation runs."
          }
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Icon}
          title="Select a workspace"
          description={
            variant === "playground"
              ? "Choose a workspace before creating or viewing workspace-bound testing suites."
              : "Choose a workspace to view shared CI evaluation runs."
          }
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  return <>{children}</>;
}
