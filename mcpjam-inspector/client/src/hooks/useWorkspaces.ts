import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import type { WorkspaceVisibility } from "@/state/app-types";
import type { WorkspaceClientConfig } from "@/lib/client-config";

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
  clientConfig?: WorkspaceClientConfig;
  servers: Record<string, any>;
  canDeleteWorkspace?: boolean;
  organizationId: string;
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
  autoEvalSuiteId?: string;
  autoEvalSuiteSuppressedAt?: number;
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

interface WorkspaceMembersQueryResult {
  members: WorkspaceMember[];
  canManageMembers: boolean;
}

function isWorkspaceMembersQueryResult(
  value: unknown,
): value is WorkspaceMembersQueryResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as WorkspaceMembersQueryResult).members)
  );
}

export function normalizeWorkspaceMembersResult(
  value: WorkspaceMember[] | WorkspaceMembersQueryResult | undefined,
): WorkspaceMembersQueryResult {
  if (Array.isArray(value)) {
    return { members: value, canManageMembers: false };
  }

  if (isWorkspaceMembersQueryResult(value)) {
    return {
      members: value.members,
      canManageMembers: value.canManageMembers,
    };
  }

  return { members: [], canManageMembers: false };
}

export function filterWorkspacesForOrganization(
  workspaces: RemoteWorkspace[] | undefined,
  organizationId?: string,
) {
  if (!workspaces || !organizationId) return workspaces;

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
    allWorkspaces: queriedWorkspaces,
    workspaces,
    sortedWorkspaces,
    isLoading,
    hasWorkspaces: (workspaces?.length ?? 0) > 0,
    hasAnyWorkspaces: (queriedWorkspaces?.length ?? 0) > 0,
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

  const membersResult = useQuery(
    "workspaces:getWorkspaceMembers" as any,
    enableQuery ? ({ workspaceId } as any) : "skip",
  ) as WorkspaceMember[] | WorkspaceMembersQueryResult | undefined;

  const isLoading = enableQuery && membersResult === undefined;

  const { members, canManageMembers } = useMemo(
    () => normalizeWorkspaceMembersResult(membersResult),
    [membersResult],
  );

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
  const ensureDefaultWorkspace = useMutation(
    "workspaces:ensureDefaultWorkspace" as any,
  );
  const updateWorkspace = useMutation("workspaces:updateWorkspace" as any);
  const updateClientConfig = useMutation(
    "workspaces:updateClientConfig" as any,
  );
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
    ensureDefaultWorkspace,
    updateWorkspace,
    updateClientConfig,
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
