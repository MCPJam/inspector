import type { ReactNode } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { Button } from "@mcpjam/design-system/button";
import type { OrganizationBillingStatus } from "@/hooks/useOrganizationBilling";

import { ErrorBoundary } from "@/components/ui/error-boundary";

type Access = "allowed" | "loading" | "unavailable" | "upgrade";
export function sharedSettingsAccess(
  userId: string | null | undefined,
  creatorId: string | null | undefined,
  billing:
    | Pick<OrganizationBillingStatus, "effectivePlan" | "pricingVersion">
    | undefined,
): Access {
  if (userId === undefined) return "loading";
  if (!userId) return "unavailable";
  if (creatorId && userId === creatorId) return "allowed";
  if (
    // Legacy Free retains its existing role-based collaboration access.
    (billing?.effectivePlan === "free" && billing.pricingVersion === "v1") ||
    billing?.effectivePlan === "team" ||
    billing?.effectivePlan === "enterprise"
  )
    return "allowed";
  if (!creatorId) return "unavailable";
  if (!billing) return "loading";
  return "upgrade";
}

/** Presentation only: existing server and role authorization remain authoritative. */
function SharedSettingsAccess({
  projectId,
  creatorId,
  resource,
  children,
}: {
  projectId: string | null | undefined;
  creatorId: string | null | undefined;
  resource: string;
  children: ReactNode;
}) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ready = useDbUserReady();
  const enabled = isAuthenticated && ready && !!projectId;
  const user = useQuery(
    "users:getCurrentUser" as any,
    enabled ? {} : "skip",
  ) as { _id: string } | null | undefined;
  const projects = useQuery(
    "projects:getMyProjects" as any,
    enabled ? {} : "skip",
  ) as { _id: string; organizationId: string }[] | undefined;
  const organizationId = projects?.find(
    (project) => project._id === projectId,
  )?.organizationId;
  const billing = useQuery(
    "billing:getOrganizationBillingStatus" as any,
    enabled && organizationId ? { organizationId } : "skip",
  ) as OrganizationBillingStatus | undefined;
  if (!projectId) return <>{children}</>;
  const access =
    projects !== undefined && !organizationId && user?._id !== creatorId
      ? "unavailable"
      : sharedSettingsAccess(
          isLoading || (isAuthenticated && (!ready || user === undefined))
            ? undefined
            : user?._id ?? null,
          creatorId,
          billing,
        );
  if (access === "allowed") return <>{children}</>;
  return (
    <>
      <section
        className="space-y-3 rounded-lg border border-border p-4"
        aria-label="Settings access"
      >
        <p
          role={access === "loading" ? "status" : "alert"}
          className="text-sm text-muted-foreground"
        >
          {access === "loading"
            ? "Checking access…"
            : access === "upgrade"
            ? `Editing someone else’s ${resource} requires Team or Enterprise.`
            : "We couldn’t verify your access to these settings. Refresh the page or ask a project admin."}
        </p>
        {access === "upgrade" && organizationId && (
          <>
            <p className="text-xs text-muted-foreground">
              Your project role still determines what you can edit.
            </p>
            <Button asChild variant="outline" size="sm">
              <a
                href={`/organizations/${encodeURIComponent(
                  organizationId,
                )}/plans`}
              >
                View Team plans
              </a>
            </Button>
          </>
        )}
      </section>
      {access === "upgrade" && (
        <fieldset
          disabled
          className="min-w-0 flex-1"
          aria-label="Read-only settings"
        >
          {children}
        </fieldset>
      )}
    </>
  );
}

export function SharedSettingsGate(
  props: Parameters<typeof SharedSettingsAccess>[0],
) {
  if (!props.projectId) return <>{props.children}</>;
  return (
    <ErrorBoundary
      name="shared-settings-access"
      key={`${props.projectId}:${props.creatorId}`}
      fallback={({ reset }) => (
        <section
          className="space-y-3 rounded-lg border border-border p-4"
          aria-label="Settings access"
        >
          <p role="alert" className="text-sm text-muted-foreground">
            We couldn’t check your access to these settings. Please try again.
          </p>
          <Button variant="outline" size="sm" onClick={reset}>
            Try again
          </Button>
        </section>
      )}
    >
      <SharedSettingsAccess {...props} />
    </ErrorBoundary>
  );
}
