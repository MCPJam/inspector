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
  isDirectGuest = false,
  children,
}: {
  variant: EvalTabGateVariant;
  isLoading: boolean;
  isAuthenticated: boolean;
  user: unknown;
  workspaceId: string | null | undefined;
  /**
   * True when the caller has classified this session as a hosted direct guest
   * (no workspace, no share/sandbox token). Direct guests bypass the sign-in
   * wall for the Playground variant only.
   */
  isDirectGuest?: boolean;
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

  if (variant === "playground") {
    if (isDirectGuest) {
      return <>{children}</>;
    }

    if (!isAuthenticated || !user) {
      return (
        <div className="p-6">
          <EmptyState
            icon={Icon}
            title="Sign in to use Testing"
            description="Create an account or sign in to explore cases and investigate runs."
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
            description="Choose a workspace before creating or viewing workspace-bound testing suites."
            className="h-[calc(100vh-200px)]"
          />
        </div>
      );
    }
  }

  return <>{children}</>;
}
