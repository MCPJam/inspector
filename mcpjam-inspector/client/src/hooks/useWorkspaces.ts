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

// Flat server structure from the servers table
export interface RemoteServer {
  _id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  // STDIO fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // HTTP fields
  url?: string;
  headers?: Record<string, string>;
  // Shared fields
  timeout?: number;
  // OAuth fields
  useOAuth?: boolean;
  oauthScopes?: string[];
  clientId?: string;
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

// Server mutations for the flat servers table
export function useServerMutations() {
  const createServer = useMutation("servers:createServer" as any);
  const updateServer = useMutation("servers:updateServer" as any);
  const deleteServer = useMutation("servers:deleteServer" as any);

  return {
    createServer,
    updateServer,
    deleteServer,
  };
}

export function useWorkspaceServers({
  workspaceId,
  isAuthenticated,
}: {
  workspaceId: string | null;
  isAuthenticated: boolean;
}) {
  const servers = useQuery(
    "servers:getWorkspaceServers" as any,
    isAuthenticated && workspaceId ? ({ workspaceId } as any) : "skip",
  ) as RemoteServer[] | undefined;

  const isLoading = isAuthenticated && workspaceId && servers === undefined;

  // Convert array to record keyed by server name
  const serversRecord = useMemo(() => {
    if (!servers) return {};
    return Object.fromEntries(servers.map((s) => [s.name, s]));
  }, [servers]);

  return {
    servers,
    serversRecord,
    isLoading,
    hasServers: (servers?.length ?? 0) > 0,
  };
}
