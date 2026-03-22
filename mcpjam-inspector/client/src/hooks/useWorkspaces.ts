import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import type { WorkspaceVisibility } from "@/state/app-types";

export type WorkspaceMembershipRole = "owner" | "admin" | "member" | "guest";
export type WorkspaceRole = "admin" | "editor";
export type WorkspaceMemberAccessSource =
  | "organization"
  | "workspace"
  | "invite";

export interface RemoteWorkspace {
  _id: string;
  name: string;
  description?: string;
  icon?: string;
  servers: Record<string, any>;
  organizationId?: string;
  visibility?: WorkspaceVisibility;
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
  organizationId?: string;
  userId?: string;
  email: string;
  role?: WorkspaceMembershipRole;
  workspaceRole: WorkspaceRole;
  canChangeRole: boolean;
  addedBy: string;
  addedAt: number;
  revokedAt?: number;
  isOwner: boolean;
  isPending: boolean;
  hasAccess: boolean;
  accessSource: WorkspaceMemberAccessSource;
  canRemove: boolean;
  user: {
    name: string;
    email: string;
    imageUrl: string;
  } | null;
}

export function filterWorkspacesForOrganization(
  workspaces: RemoteWorkspace[] | undefined,
  organizationId?: string,
) {
  if (!workspaces || !organizationId) return workspaces;

  // Keep the legacy unscoped behavior until every returned workspace has been
  // backfilled with an organizationId.
  const allWorkspacesAreScoped = workspaces.every(
    (workspace) => workspace.organizationId !== undefined,
  );
  if (!allWorkspacesAreScoped) {
    return workspaces;
  }

  return workspaces.filter(
    (workspace) => workspace.organizationId === organizationId,
  );
}

export function useWorkspaceQueries({
  isAuthenticated,
  organizationId,
}: {
  isAuthenticated: boolean;
  organizationId?: string;
}) {
  const queriedWorkspaces = useQuery(
    "workspaces:getMyWorkspaces" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as RemoteWorkspace[] | undefined;

  const isLoading = isAuthenticated && queriedWorkspaces === undefined;

  const workspaces = useMemo(
    () => filterWorkspacesForOrganization(queriedWorkspaces, organizationId),
    [queriedWorkspaces, organizationId],
  );

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

  const raw = useQuery(
    "workspaces:getWorkspaceMembers" as any,
    enableQuery ? ({ workspaceId } as any) : "skip",
  ) as
    | { members: WorkspaceMember[]; canManageMembers: boolean }
    | WorkspaceMember[]
    | undefined;

  // Server returns `{ members, canManageMembers }`. Legacy deployments returned a bare array.
  const members = Array.isArray(raw) ? raw : raw?.members;
  const canManageMembers = Array.isArray(raw)
    ? false
    : (raw?.canManageMembers ?? false);
  const isLoading = enableQuery && raw === undefined;

  const activeMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => !m.isPending);
  }, [members]);

  const pendingMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => m.isPending);
  }, [members]);

  return {
    members,
    activeMembers,
    pendingMembers,
    canManageMembers,
    isLoading,
    hasPendingMembers: pendingMembers.length > 0,
  };
}

export function useWorkspaceMutations() {
  const createWorkspace = useMutation("workspaces:createWorkspace" as any);
  const updateWorkspace = useMutation("workspaces:updateWorkspace" as any);
  const deleteWorkspace = useMutation("workspaces:deleteWorkspace" as any);
  const inviteWorkspaceMember = useMutation(
    "workspaces:inviteWorkspaceMember" as any,
  );
  const removeWorkspaceMember = useMutation(
    "workspaces:removeWorkspaceMember" as any,
  );
  const updateWorkspaceMemberRole = useMutation(
    "workspaces:updateWorkspaceMemberRole" as any,
  );
  const updateWorkspaceInviteRole = useMutation(
    "workspaces:updateWorkspaceInviteRole" as any,
  );

  return {
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    inviteWorkspaceMember,
    removeWorkspaceMember,
    updateWorkspaceMemberRole,
    updateWorkspaceInviteRole,
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
