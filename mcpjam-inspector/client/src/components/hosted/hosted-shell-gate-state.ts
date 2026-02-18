import type { HostedShellGateState } from "./HostedShellGate";

interface ResolveHostedShellGateStateOptions {
  hostedMode: boolean;
  isConvexAuthLoading: boolean;
  isConvexAuthenticated: boolean;
  isWorkOsLoading: boolean;
  hasWorkOsUser: boolean;
  isLoadingRemoteWorkspaces: boolean;
}

export function resolveHostedShellGateState({
  hostedMode,
  isConvexAuthLoading,
  isConvexAuthenticated,
  isWorkOsLoading,
  hasWorkOsUser,
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

  if (!hasWorkOsUser && !isConvexAuthenticated) {
    return "logged-out";
  }

  if (isLoadingRemoteWorkspaces) {
    return "workspace-loading";
  }

  return "ready";
}
