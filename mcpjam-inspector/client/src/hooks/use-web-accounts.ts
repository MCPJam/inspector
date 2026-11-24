import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import {
  shouldQueryProjectId,
  useCanManageProjectClients,
} from "@/hooks/useProjects";
import { useWebClientsEnabled } from "@/hooks/useWebClientsEnabled";
import { webAccountsApi } from "@/lib/web-accounts/api";
import type { WebClientVendor } from "@/shared/web-clients";

/**
 * One web client's accounts in a project, and whether the viewer manages
 * them. Managing is the same project admin check the backend makes for
 * shared MCP accounts. Nothing is asked while the flag is off.
 */
export function useWebAccounts(
  projectId: string | null | undefined,
  vendor: WebClientVendor | undefined,
) {
  const { isAuthenticated } = useConvexAuth();
  const enabled = useWebClientsEnabled();
  const queryable = shouldQueryProjectId(projectId);
  const asks = enabled && isAuthenticated && !!vendor && queryable;
  const all = useQuery(
    webAccountsApi.list,
    asks && projectId ? { projectId } : "skip",
  );
  const { canManage, isLoading: roleLoading } = useCanManageProjectClients({
    isAuthenticated,
    projectId,
  });
  const accounts = useMemo(
    () => (all ?? []).filter((account) => account.vendor === vendor),
    [all, vendor],
  );
  // Loaded only once the role is known too, so an admin never sees a
  // member's view on the way in. A project the list can't be asked about
  // (local or unsaved) has no web accounts, rather than loading for good.
  return {
    accounts,
    loaded: (!queryable || all !== undefined) && !roleLoading,
    isAdmin: canManage,
  };
}

/**
 * The project's web accounts beside this person's choices for a suite. Asked
 * only while the flag is on.
 */
export function useSuiteWebAccounts(suiteId: string, projectId: string) {
  const { isAuthenticated } = useConvexAuth();
  const asks =
    useWebClientsEnabled() &&
    isAuthenticated &&
    shouldQueryProjectId(projectId);
  const accounts = useQuery(webAccountsApi.list, asks ? { projectId } : "skip");
  const selections = useQuery(
    webAccountsApi.mySuiteChoices,
    asks ? { suiteId } : "skip",
  );
  return {
    accounts: accounts ?? [],
    selections: selections ?? [],
    // An empty list would also mean "nothing saved yet", a different thing.
    selectionsLoaded: selections !== undefined,
  };
}
