import type { HostedShellGateState } from "./HostedShellGate";
import { isAllowedEmployeeEmail } from "@/lib/config";

interface ResolveHostedShellGateStateOptions {
  hostedMode: boolean;
  nonProdLockdown: boolean;
  isConvexAuthLoading: boolean;
  isConvexAuthenticated: boolean;
  isWorkOsLoading: boolean;
  hasWorkOsUser: boolean;
  workOsUserEmail?: string | null;
  isLoadingRemoteWorkspaces: boolean;
}

export function resolveHostedShellGateState({
  hostedMode,
  nonProdLockdown,
  isConvexAuthLoading,
  isConvexAuthenticated,
  isWorkOsLoading,
  hasWorkOsUser,
  workOsUserEmail,
  isLoadingRemoteWorkspaces,
}: ResolveHostedShellGateStateOptions): HostedShellGateState {
  if (!hostedMode) {
    return "ready";
  }

  const isAuthSettling =
    isWorkOsLoading ||
    isConvexAuthLoading ||
    (hasWorkOsUser && !isConvexAuthenticated);
  if (isAuthSettling) {
    return "auth-loading";
  }

  if (nonProdLockdown) {
    if (!hasWorkOsUser || !isConvexAuthenticated) {
      return "logged-out";
    }

    if (!isAllowedEmployeeEmail(workOsUserEmail)) {
      return "restricted";
    }
  }

  if (!hasWorkOsUser && !isConvexAuthenticated) {
    return "ready";
  }

  if (isLoadingRemoteWorkspaces) {
    return "workspace-loading";
  }

  return "ready";
}
