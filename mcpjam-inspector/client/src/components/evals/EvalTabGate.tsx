import type { ReactNode } from "react";
import { FlaskConical, GitBranch } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export type EvalTabGateVariant = "playground" | "ci";

export function EvalTabGate({
  variant,
  isLoading,
  isAuthenticated,
  user,
  projectId,
  isDirectGuest = false,
  header,
  children,
}: {
  variant: EvalTabGateVariant;
  isLoading: boolean;
  isAuthenticated: boolean;
  user: unknown;
  projectId: string | null | undefined;
  /**
   * True when the caller has classified this session as a hosted direct guest
   * (no project, no share/sandbox token). Direct guests bypass the sign-in
   * wall for the Playground variant only.
   */
  isDirectGuest?: boolean;
  /**
   * Chrome rendered ABOVE every gate state, including the sign-in wall and the
   * loading spinner. The Suites | Runs switcher lives here: Runs mode is
   * guest-reachable (it hosts the SDK quickstart), so a signed-out user stuck
   * on the Suites wall must still be able to get there.
   */
  header?: ReactNode;
  children: ReactNode;
}) {
  const Icon = variant === "playground" ? FlaskConical : GitBranch;

  const withHeader = (body: ReactNode) =>
    header ? (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {header}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {body}
        </div>
      </div>
    ) : (
      <>{body}</>
    );

  if (isLoading) {
    return withHeader(
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
      return withHeader(children);
    }

    if (!isAuthenticated || (!user && !projectId)) {
      return withHeader(
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

    if (!projectId) {
      return withHeader(
        <div className="p-6">
          <EmptyState
            icon={Icon}
            title="Select a project"
            description="Choose a project before creating or viewing project-bound testing suites."
            className="h-[calc(100vh-200px)]"
          />
        </div>
      );
    }
  }

  return withHeader(children);
}
