import { useCallback, useMemo } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useOrgScopedWrite } from "@/hooks/useOrgScopedWrite";

/**
 * The lowest organization role that may create API keys bound to the org.
 * `member` is what every organization has until an admin changes it.
 */
export type ApiKeyMintMinimumRole = "member" | "admin";

export type OrgApiKeyPolicy = {
  mintMinimumRole: ApiKeyMintMinimumRole;
  updatedAt: number | null;
};

/**
 * Who may create organization-bound API keys. Member-read, admin-write; the
 * backend enforces the rule where a key is bound, so this is the setting, not
 * the gate.
 */
export function useOrgApiKeyPolicy(organizationId: string | null): {
  policy: OrgApiKeyPolicy | undefined;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  setMintMinimumRole: (next: ApiKeyMintMinimumRole) => Promise<void>;
} {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enabled = Boolean(organizationId) && isAuthenticated && isUserReady;

  const policy = useQuery(
    "orgApiKeyPolicy:getOrgApiKeyPolicy" as never,
    enabled ? ({ organizationId } as never) : "skip",
  ) as OrgApiKeyPolicy | undefined;

  const savePolicy = useMutation("orgApiKeyPolicy:setOrgApiKeyPolicy" as never);
  const { error, isSaving, run } = useOrgScopedWrite(organizationId);

  const setMintMinimumRole = useCallback(
    async (next: ApiKeyMintMinimumRole) => {
      if (!organizationId) return;
      await run(() =>
        savePolicy({ organizationId, mintMinimumRole: next } as never),
      );
    },
    [organizationId, run, savePolicy],
  );

  return useMemo(
    () => ({
      policy,
      isLoading: Boolean(organizationId) && policy === undefined,
      error,
      isSaving,
      setMintMinimumRole,
    }),
    [organizationId, policy, error, isSaving, setMintMinimumRole],
  );
}
