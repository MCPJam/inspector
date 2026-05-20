import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";

export type HostedOrgModelConfig = {
  providers: OrgModelProvider[];
};

export function useHostedOrgModelConfig({
  projectId,
  organizationId,
}: {
  projectId?: string | null;
  organizationId?: string | null;
}): HostedOrgModelConfig | undefined {
  const { isAuthenticated } = useConvexAuth();
  const shouldQuery = isAuthenticated;

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
