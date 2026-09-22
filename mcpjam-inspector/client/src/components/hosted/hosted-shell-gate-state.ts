import type { HostedShellGateState } from "./HostedShellGate";

interface ResolveHostedShellGateStateOptions {
  hostedMode: boolean;
  isConvexAuthLoading: boolean;
  isConvexAuthenticated: boolean;
  isWorkOsLoading: boolean;
  hasWorkOsUser: boolean;
}

export function resolveHostedShellGateState({
  hostedMode,
  isConvexAuthLoading,
  isConvexAuthenticated,
  isWorkOsLoading,
  hasWorkOsUser,
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

  return "ready";
}
