import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";

export interface RemoteWorkspace {
  _id: string;
  name: string;
  description?: string;
  servers: Record<string, any>;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceMember {
  _id: string;
  workspaceId: string;
  userId?: string;
  email: string;
  addedBy: string;
  addedAt: number;
  isOwner: boolean;
  user: {
    name: string;
    email: string;
    imageUrl: string;
  } | null;
}

export function useWorkspaceQueries({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const workspaces = useQuery(
    "workspaces:getMyWorkspaces" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as RemoteWorkspace[] | undefined;

  const isLoading = isAuthenticated && workspaces === undefined;

  const sortedWorkspaces = useMemo(() => {
    if (!workspaces) return [];
    return [...workspaces].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [workspaces]);

  return {
    workspaces,
    sortedWorkspaces,
    isLoading,
    hasWorkspaces: (workspaces?.length ?? 0) > 0,
  };
}

export function useWorkspaceMembers({
  isAuthenticated,
  workspaceId,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
}) {
  const enableQuery = isAuthenticated && !!workspaceId;

  const members = useQuery(
    "workspaces:getWorkspaceMembers" as any,
    enableQuery ? ({ workspaceId } as any) : "skip",
  ) as WorkspaceMember[] | undefined;

  const isLoading = enableQuery && members === undefined;

  const activeMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => m.userId !== undefined);
  }, [members]);

  const pendingMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => m.userId === undefined);
  }, [members]);

  return {
    members,
    activeMembers,
    pendingMembers,
    isLoading,
    hasPendingMembers: pendingMembers.length > 0,
  };
}

export function useWorkspaceMutations() {
  const createWorkspace = useMutation("workspaces:createWorkspace" as any);
  const updateWorkspace = useMutation("workspaces:updateWorkspace" as any);
  const deleteWorkspace = useMutation("workspaces:deleteWorkspace" as any);
  const addMember = useMutation("workspaces:addMember" as any);
  const removeMember = useMutation("workspaces:removeMember" as any);

  return {
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    addMember,
    removeMember,
  };
}
