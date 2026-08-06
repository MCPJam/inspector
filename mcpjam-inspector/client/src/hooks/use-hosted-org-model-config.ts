import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";

export type HostedOrgModelConfig = {
  providers: OrgModelProvider[];
};

export function useHostedOrgModelConfig({
  projectId,
  organizationId,
  disabled = false,
}: {
  projectId?: string | null;
  organizationId?: string | null;
  /**
   * Skip both org/project-scoped config queries entirely.
   *
   * Chatbox share-link viewers are authenticated as anonymous guests but hold
   * NO membership in the host's project. `getVisibleConfigForProject` is gated
   * by `requireProjectRole`, so it throws "Not a member of this project" for
   * them — and with no route-level ErrorBoundary that Convex error takes down
   * the whole page. The chatbox already resolves its model server-side from the
   * chatbox row (surfaced as `executionConfig.modelId`), so this config is
   * unused on that surface anyway. Chatbox callers pass `disabled: true`.
   */
  disabled?: boolean;
}): HostedOrgModelConfig | undefined {
  const { isAuthenticated } = useConvexAuth();
  const shouldQuery = isAuthenticated && !disabled;

  const projectConfig = useQuery(
    "organizationModelProviders:getVisibleConfigForProject" as any,
    shouldQuery && projectId ? ({ projectId } as any) : "skip"
  ) as HostedOrgModelConfig | undefined;

  const organizationConfig = useQuery(
    "organizationModelProviders:getVisibleConfig" as any,
    shouldQuery && organizationId ? ({ organizationId } as any) : "skip"
  ) as HostedOrgModelConfig | undefined;

  return useMemo(() => {
    if (!shouldQuery) return undefined;
    if (projectConfig && projectConfig.providers.length > 0) {
      return projectConfig;
    }
    return organizationConfig ?? projectConfig;
  }, [organizationConfig, projectConfig, shouldQuery]);
}
