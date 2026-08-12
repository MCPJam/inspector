import type { HostedShellGateState } from "./HostedShellGate";
import { isAllowedEmployeeEmail } from "@/lib/config";

interface ResolveHostedShellGateStateOptions {
  hostedMode: boolean;
  nonProdLockdown: boolean;
  /**
   * The app is mounted as the Chatboxes/User Testing Preview embed
   * (`isEmbeddedPreview()`), i.e. the author's own same-origin frame inside a
   * dashboard that already cleared this gate.
   *
   * The lockdown gate is skipped there, and skipping it is the only correct
   * outcome: the gate's Sign in button navigates the FRAME to WorkOS and
   * returns to `/oauth/callback`, a path the `main.tsx` self-embed exemption
   * deliberately does not cover, so the frame lands on `IframeRouterError`.
   * A gate the author cannot pass is a wall, not a gate — the preview renders
   * as the signed-in author, or the runtime reports why it can't; it never
   * asks them to sign in. The dashboard around it stays gated as before.
   */
  embeddedPreview?: boolean;
  isConvexAuthLoading: boolean;
  isConvexAuthenticated: boolean;
  isWorkOsLoading: boolean;
  hasWorkOsUser: boolean;
  workOsUserEmail?: string | null;
}

export function resolveHostedShellGateState({
  hostedMode,
  nonProdLockdown,
  embeddedPreview = false,
  isConvexAuthLoading,
  isConvexAuthenticated,
  isWorkOsLoading,
  hasWorkOsUser,
  workOsUserEmail,
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

  if (nonProdLockdown && !embeddedPreview) {
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

  return "ready";
}
