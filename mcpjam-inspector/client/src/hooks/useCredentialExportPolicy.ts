import { useCallback, useMemo } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useOrgScopedWrite } from "@/hooks/useOrgScopedWrite";

/** `allow` is what every organization has until an admin changes it. */
export type CredentialExportPolicy = "allow" | "deny";

/**
 * Whether the organization's saved credentials may leave MCPJam-hosted
 * connections: to members' local apps and the CLI, into sandboxes, or to a
 * browser reveal. Member-read, admin-write. The backend's credential broker
 * applies it to every delivery, so this is the setting, not the gate.
 */
export function useCredentialExportPolicy(organizationId: string | null): {
  exportPolicy: CredentialExportPolicy | undefined;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  setExportPolicy: (next: CredentialExportPolicy) => Promise<void>;
} {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enabled = Boolean(organizationId) && isAuthenticated && isUserReady;

  const result = useQuery(
    "credentials:getCredentialExportPolicy" as never,
    enabled ? ({ organizationId } as never) : "skip",
  ) as { exportPolicy: CredentialExportPolicy } | undefined;

  const savePolicy = useMutation(
    "credentials:setCredentialExportPolicy" as never,
  );
  const { error, isSaving, run } = useOrgScopedWrite(organizationId);

  const setExportPolicy = useCallback(
    async (next: CredentialExportPolicy) => {
      if (!organizationId) return;
      await run(() =>
        savePolicy({ organizationId, exportPolicy: next } as never),
      );
    },
    [organizationId, run, savePolicy],
  );

  const exportPolicy = result?.exportPolicy;
  return useMemo(
    () => ({
      exportPolicy,
      isLoading: Boolean(organizationId) && exportPolicy === undefined,
      error,
      isSaving,
      setExportPolicy,
    }),
    [organizationId, exportPolicy, error, isSaving, setExportPolicy],
  );
}
