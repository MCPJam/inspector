import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";

export type ShareMode =
  | "project_members"
  | "invited_only"
  | "anyone_with_link";

export type ShareInviteAudience = "anyone" | "org_members";

export type OrgSharePolicyKnobs = {
  maxShareMode: ShareMode;
  inviteAudience: ShareInviteAudience;
  updatedAt: number | null;
};

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) {
    const lines = error.message.split("\n").filter(Boolean);
    const last = lines[lines.length - 1] ?? error.message;
    return last.replace(/^\[.*?\]\s*/, "").trim() || error.message;
  }
  return String(error);
}

function useOrgScopedWrite(organizationId: string | null): {
  error: string | null;
  isSaving: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
} {
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const currentOrgRef = useRef(organizationId);

  useEffect(() => {
    currentOrgRef.current = organizationId;
    setError(null);
    setIsSaving(false);
  }, [organizationId]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      const startedFor = organizationId;
      setError(null);
      setIsSaving(true);
      try {
        await work();
      } catch (nextError) {
        if (currentOrgRef.current === startedFor) {
          setError(messageOf(nextError));
        }
        throw nextError;
      } finally {
        if (currentOrgRef.current === startedFor) setIsSaving(false);
      }
    },
    [organizationId],
  );

  return { error, isSaving, run };
}

export function useOrgSharePolicy(organizationId: string | null): {
  policy: OrgSharePolicyKnobs | undefined;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  setPolicy: (next: {
    maxShareMode: ShareMode;
    inviteAudience: ShareInviteAudience;
  }) => Promise<void>;
} {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enabled = Boolean(organizationId) && isAuthenticated && isUserReady;

  const policy = useQuery(
    "orgSharePolicy:getOrgSharePolicy" as never,
    enabled ? ({ organizationId } as never) : "skip",
  ) as OrgSharePolicyKnobs | undefined;

  const savePolicy = useMutation("orgSharePolicy:setOrgSharePolicy" as never);
  const { error, isSaving, run } = useOrgScopedWrite(organizationId);

  const setPolicy = useCallback(
    async (next: {
      maxShareMode: ShareMode;
      inviteAudience: ShareInviteAudience;
    }) => {
      if (!organizationId) return;
      await run(() =>
        savePolicy({
          organizationId,
          maxShareMode: next.maxShareMode,
          inviteAudience: next.inviteAudience,
        } as never),
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
      setPolicy,
    }),
    [organizationId, policy, error, isSaving, setPolicy],
  );
}

export function useEffectiveSharePolicy(projectId: string | null): {
  policy: OrgSharePolicyKnobs | undefined;
  isLoading: boolean;
} {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enabled = Boolean(projectId) && isAuthenticated && isUserReady;

  const policy = useQuery(
    "orgSharePolicy:getEffectiveSharePolicyForProject" as never,
    enabled ? ({ projectId } as never) : "skip",
  ) as OrgSharePolicyKnobs | undefined;

  return {
    policy,
    isLoading: Boolean(projectId) && policy === undefined,
  };
}
