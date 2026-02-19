import { useMutation, useQuery } from "convex/react";

export type ServerShareMode = "any_signed_in_with_link" | "invited_only";

export interface ServerShareMember {
  _id: string;
  shareId: string;
  workspaceId: string;
  email: string;
  userId?: string;
  role: "chat";
  invitedBy: string;
  invitedAt: number;
  revokedAt?: number;
  acceptedAt?: number;
  user: {
    _id: string;
    name: string;
    email: string;
    imageUrl: string;
  } | null;
}

export interface ServerShareSettings {
  shareId: string;
  workspaceId: string;
  serverId: string;
  serverName: string;
  mode: ServerShareMode;
  link: {
    token: string;
    path: string;
    url: string;
    rotatedAt: number;
    updatedAt: number;
  };
  members: ServerShareMember[];
}

export function useServerShareSettings({
  isAuthenticated,
  serverId,
}: {
  isAuthenticated: boolean;
  serverId: string | null;
}) {
  const settings = useQuery(
    "serverShares:getServerShareSettings" as any,
    isAuthenticated && serverId ? ({ serverId } as any) : "skip",
  ) as ServerShareSettings | null | undefined;

  const isLoading = isAuthenticated && !!serverId && settings === undefined;

  return {
    settings,
    isLoading,
  };
}

export function useServerShareMutations() {
  const ensureServerShare = useMutation("serverShares:ensureServerShare" as any);
  const setServerShareMode = useMutation("serverShares:setServerShareMode" as any);
  const rotateServerShareLink = useMutation(
    "serverShares:rotateServerShareLink" as any,
  );
  const upsertServerShareMember = useMutation(
    "serverShares:upsertServerShareMember" as any,
  );
  const removeServerShareMember = useMutation(
    "serverShares:removeServerShareMember" as any,
  );

  return {
    ensureServerShare,
    setServerShareMode,
    rotateServerShareLink,
    upsertServerShareMember,
    removeServerShareMember,
  };
}
