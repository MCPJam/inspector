import { useCallback } from "react";
import { useConvexAuth } from "convex/react";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";
import {
  canManageOrgModels,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";

/**
 * Navigates to where an organization's provider keys live, for the model
 * picker's "Your providers" footer.
 *
 * Returns `undefined` when there is no org (personal or hosted surfaces) or the
 * viewer may not open its settings screens, so callers pass nothing and the
 * footer stays absent rather than rendering a control that lands on
 * `OrganizationAccessRestricted`. Fails closed while the org list loads.
 */
export function useOrgModelsHandoff(
  organizationId: string | null,
): (() => void) | undefined {
  const { isAuthenticated } = useConvexAuth();
  const { sortedOrganizations } = useOrganizationQueries({ isAuthenticated });
  const canManage = canManageOrgModels(
    organizationId
      ? sortedOrganizations.find((org) => org._id === organizationId)
      : null,
  );
  const appNavigate = useAppNavigate();
  const navigateToOrgModels = useCallback(() => {
    if (!organizationId) return;
    appNavigate(buildOrganizationPath(organizationId, "models"));
  }, [appNavigate, organizationId]);

  return canManage ? navigateToOrgModels : undefined;
}
