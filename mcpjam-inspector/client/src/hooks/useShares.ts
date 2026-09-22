import { useMutation, useQuery } from "convex/react";
import type { ShareSettingsEnvelope } from "@/components/sharing/share-types";

export type ShareResourceType = "scenario" | "conformanceRun" | "evalRun";
export type ShareMode = ShareSettingsEnvelope["mode"];

export function useShareSettings({
  isAuthenticated,
  resourceType,
  resourceId,
}: {
  isAuthenticated: boolean;
  resourceType: ShareResourceType | null;
  resourceId: string | null;
}) {
  const enabled = isAuthenticated && !!resourceType && !!resourceId;
  const settings = useQuery(
    "shares:getShareSettings" as never,
    enabled
      ? ({ resourceType, resourceId } as never)
      : "skip",
  ) as ShareSettingsEnvelope | null | undefined;

  return {
    settings,
    isLoading: enabled && settings === undefined,
  };
}

export function useShareMutations() {
  const setShareMode = useMutation("shares:setShareMode" as never);
  const rotateShareLink = useMutation("shares:rotateShareLink" as never);
  const upsertShareMember = useMutation("shares:upsertShareMember" as never);
  const removeShareMember = useMutation("shares:removeShareMember" as never);
  const revokeAllShares = useMutation("shares:revokeAllShares" as never);

  return {
    setShareMode: (args: {
      resourceType: ShareResourceType;
      resourceId: string;
      mode: ShareMode;
      allowGuestAccess?: boolean;
    }) => setShareMode(args as never) as Promise<ShareSettingsEnvelope>,
    rotateShareLink: (args: {
      resourceType: ShareResourceType;
      resourceId: string;
    }) => rotateShareLink(args as never) as Promise<ShareSettingsEnvelope>,
    upsertShareMember: (args: {
      resourceType: ShareResourceType;
      resourceId: string;
      email: string;
      sendInviteEmail: boolean;
    }) => upsertShareMember(args as never) as Promise<ShareSettingsEnvelope>,
    removeShareMember: (args: {
      resourceType: ShareResourceType;
      resourceId: string;
      memberIdOrEmail: string;
    }) => removeShareMember(args as never) as Promise<ShareSettingsEnvelope>,
    revokeAllShares: (args: {
      resourceType: ShareResourceType;
      resourceId: string;
    }) => revokeAllShares(args as never) as Promise<ShareSettingsEnvelope>,
  };
}
